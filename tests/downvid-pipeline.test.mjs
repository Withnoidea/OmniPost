import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSource, normalizeProxy } from '../dist/packages/core/src/fetcher/config.js';
import { classifyDownloadError, FetcherError } from '../dist/packages/core/src/fetcher/errors.js';
import { prepareManual } from '../dist/packages/core/src/fetcher/manual.js';
import { DownloadScheduler } from '../dist/packages/core/src/fetcher/scheduler.js';

test('Downvid URL normalization supports Douyin, Bilibili, and Kuaishou formats', () => {
  // Douyin
  assert.deepEqual(normalizeSource('https://v.douyin.com/iNNxxxx/'), {
    url: 'https://v.douyin.com/iNNxxxx/',
    platform: 'douyin',
  });
  assert.deepEqual(normalizeSource('https://www.douyin.com/video/7123456789012345678'), {
    url: 'https://www.douyin.com/video/7123456789012345678',
    platform: 'douyin',
  });

  // Bilibili
  assert.deepEqual(normalizeSource('https://b23.tv/abc1234'), {
    url: 'https://b23.tv/abc1234',
    platform: 'bilibili',
  });
  assert.deepEqual(normalizeSource('https://www.bilibili.com/video/BV1xx411c7mD'), {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
  });

  // Kuaishou
  assert.deepEqual(normalizeSource('https://v.kuaishou.com/abcdef'), {
    url: 'https://v.kuaishou.com/abcdef',
    platform: 'kuaishou',
  });
  assert.deepEqual(normalizeSource('https://www.kuaishou.com/short-video/3x987654321'), {
    url: 'https://www.kuaishou.com/short-video/3x987654321',
    platform: 'kuaishou',
  });
});

test('Downvid error classification identifies 403, 429 and YouTube challenges with actionable guidance', () => {
  const err403 = classifyDownloadError('ERROR: [generic] HTTP Error 403: Forbidden');
  assert.equal(err403.code, 'AUTH_REQUIRED');
  assert.ok(err403.message.includes('403') || err403.message.includes('反爬') || err403.message.includes('访问受限'));

  const err429 = classifyDownloadError('ERROR: HTTP Error 429: Too Many Requests');
  assert.equal(err429.code, 'RATE_LIMITED');
  assert.ok(err429.message.includes('429') || err429.message.includes('限流') || err429.message.includes('频率限制'));

  const errNsig = classifyDownloadError('ERROR: [youtube] SomeVideo: n-sig extraction failed: Some JS challenge error');
  assert.equal(errNsig.code, 'DOWNLOAD_FAILED');
  assert.ok(errNsig.message.includes('挑战') || errNsig.message.includes('解析') || errNsig.message.includes('反爬'));
});

test('manual video attachment automatically extracts duration, resolution and captures cover.jpg', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'omni-manual-probe-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const videoPath = path.join(root, 'source.mp4');
  await writeFile(videoPath, Buffer.from('mock-mp4-video-content'));

  const targetDir = path.join(root, 'task-dir');
  await mkdir(targetDir, { recursive: true });

  const fakeRunner = async (request) => {
    // Mock ffprobe returning duration and resolution
    if (request.args.includes('-show_entries')) {
      const probeJson = JSON.stringify({
        format: { duration: '124.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
      });
      request.onLine?.(probeJson);
      return { exitCode: 0, stdout: probeJson, stderr: '' };
    }
    // Mock ffmpeg capturing frame
    if (request.args.includes('-frames:v')) {
      const outTarget = request.args[request.args.length - 1];
      // JPEG magic numbers: 0xFF 0xD8 0xFF
      await writeFile(outTarget, Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const tools = {
    ytDlp: 'mock-ytdlp',
    ffmpeg: 'mock-ffmpeg',
    ffprobe: 'mock-ffprobe',
    node: 'mock-node',
  };

  const task = {
    schemaVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    sourceUrl: '',
    platform: 'local',
    state: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const manifest = await prepareManual(
    task,
    { title: '本地测试视频', description: 'desc', author: 'tester', tags: ['tag1'], videoPath },
    targetDir,
    tools,
    fakeRunner,
    AbortSignal.timeout(5000)
  );

  assert.equal(manifest.metadata.title, '本地测试视频');
  assert.equal(manifest.metadata.durationSeconds, 125);
  assert.equal(manifest.metadata.width, 1920);
  assert.equal(manifest.metadata.height, 1080);
  assert.equal(manifest.thumbnail.file, 'cover.jpg');

  const savedMetadata = JSON.parse(await readFile(path.join(targetDir, 'metadata.json'), 'utf8'));
  assert.equal(savedMetadata.durationSeconds, 125);
  assert.equal(savedMetadata.width, 1920);
  assert.equal(savedMetadata.height, 1080);
});

test('scheduler.deleteTask(id) cancels active task and purges job, work, and asset directories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'omnipost-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scheduler = await DownloadScheduler.create({
    dataDirectory: root,
    tools: { ytDlp: 'mock', ffmpeg: 'mock', ffprobe: 'mock', node: 'mock' },
  }, async () => ({ exitCode: 0, stdout: '', stderr: '' }));

  const task = await scheduler.createManual({
    title: '即将被删除的素材',
    description: 'desc',
    author: 'author',
    tags: [],
    platform: 'local',
  });

  const taskId = task.id;
  assert.ok(scheduler.getTask(taskId));

  const jobFile = path.join(root, 'jobs', `${taskId}.json`);
  const assetDir = path.join(root, 'assets', taskId);
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, 'dummy.txt'), 'content');

  await scheduler.deleteTask(taskId);

  assert.equal(scheduler.getTask(taskId), undefined);

  let jobExists = true;
  try { await readFile(jobFile); } catch (e) { if (e.code === 'ENOENT') jobExists = false; }
  assert.equal(jobExists, false);

  let assetExists = true;
  try { await readFile(path.join(assetDir, 'dummy.txt')); } catch (e) { if (e.code === 'ENOENT') assetExists = false; }
  assert.equal(assetExists, false);

  await scheduler.close();
});
