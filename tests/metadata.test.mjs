import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadScheduler, FetcherError } from '../dist/packages/core/src/index.js';
import { buildMetadataArguments } from '../dist/packages/core/src/fetcher/downloader.js';

const url = 'https://youtu.be/BaW_jenozKc';
const tools = { ytDlp: process.execPath, node: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath };
const raw = { id: 'BaW_jenozKc', title: '独立元数据 🌏', description: 'Description for AI', duration: 1 };
const mediaBytes = Buffer.from('MP4 fixture for injected probe');
const probe = (request) => {
  request.onLine('{"streams":[{"codec_type":"video"}],"format":{"duration":"1","format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}');
  return { exitCode: 0, stderr: '' };
};
async function metadataRunner(request) {
  if (request.args.includes('-show_entries')) return probe(request);
  assert.ok(request.args.includes('--skip-download'), 'metadata runner must not download media');
  await writeFile(path.join(request.cwd, 'media.info.json'), JSON.stringify(raw));
  await writeFile(path.join(request.cwd, 'cover.webp'), 'original cover');
  return { exitCode: 0, stderr: '' };
}
async function fixture(t, options = {}, runner = metadataRunner) {
  const root = await mkdtemp(path.join(tmpdir(), 'omnipost-metadata-'));
  const dataDirectory = path.join(root, 'data');
  const instances = [];
  const open = async (overrides = {}, run = runner) => {
    const scheduler = await DownloadScheduler.create({ dataDirectory, tools, ...options, ...overrides }, run);
    instances.push(scheduler); return scheduler;
  };
  t.after(async () => {
    for (const scheduler of instances) await scheduler.close();
    assert.equal(path.dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'IDM completed video.MP4');
  await writeFile(source, mediaBytes);
  return { root, source, dataDirectory, open, scheduler: await open() };
}

test('metadata arguments exclude format selection, remuxing, FFmpeg and video progress', () => {
  const args = buildMetadataArguments(url, 'http://u:secret@host:8080', { tools, socketTimeoutSeconds: 5, retries: 0 });
  for (const flag of ['--skip-download', '--dump-json', '--write-info-json', '--write-thumbnail', '--ignore-config']) assert.ok(args.includes(flag));
  for (const flag of ['--format', '--merge-output-format', '--remux-video', '--ffmpeg-location', '--print', '--progress']) assert.ok(!args.includes(flag));
  assert.deepEqual(args.slice(-2), ['--', url]);
});
test('metadata alone commits info and cover, needs no FFmpeg, and remains awaiting on close/restart', async (t) => {
  const events = [];
  const missing = path.join(tmpdir(), 'omnipost-no-ffmpeg.exe');
  const { scheduler, open, dataDirectory } = await fixture(t, {
    tools: { ...tools, ffmpeg: missing, ffprobe: missing }, onEvent: (event) => events.push(event),
    onMetadata: async () => { throw new Error('ignored UI error'); },
  });
  const task = await scheduler.fetchMetadata(url, { proxy: 'http://u:secret@host:8080' });
  assert.equal(task.state, 'AWAITING_MEDIA'); assert.equal(task.mode, 'metadata'); assert.equal(task.asset, undefined);
  assert.equal(task.metadataAsset.metadata.title, raw.title);
  assert.deepEqual((await readdir(scheduler.getAssetDirectory(task.id))).sort(), ['cover.webp', 'media.info.json', 'metadata.json', 'metadata.manifest.json']);
  assert.equal(events.filter((event) => event.type === 'metadata').length, 1);
  assert.equal(events.filter((event) => event.type === 'success').length, 0);
  const journal = await readFile(path.join(dataDirectory, 'jobs', `${task.id}.json`), 'utf8');
  assert.ok(!journal.includes('secret')); assert.ok(!JSON.stringify(events).includes('secret'));
  await scheduler.close();
  const restored = await open();
  assert.equal((await restored.waitFor(task.id)).state, 'AWAITING_MEDIA');
});
test('metadata gets a separate bounded lane even when the video lane is saturated', { timeout: 5000 }, async (t) => {
  let downloads = 0; let metadataActive = 0; let maximum = 0;
  const { scheduler } = await fixture(t, { concurrency: 1 }, async (request) => {
    if (request.args.includes('--skip-download')) {
      metadataActive++; maximum = Math.max(maximum, metadataActive);
      await delay(20); const result = await metadataRunner(request); metadataActive--; return result;
    }
    downloads++;
    return new Promise((_, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  });
  const video = await scheduler.enqueue({ url });
  const tasks = await Promise.all([scheduler.fetchMetadata(url), scheduler.fetchMetadata(url)]);
  assert.ok(tasks.every((task) => task.state === 'AWAITING_MEDIA'));
  assert.equal(downloads, 1); assert.equal(maximum, 1);
  assert.equal(scheduler.getTask(video.id).state, 'downloading');
  await scheduler.cancel(video.id);
});
test('local attachment after restart only needs ffprobe and keeps original source and metadata unchanged', async (t) => {
  const { scheduler, source, open, root } = await fixture(t);
  const waiting = await scheduler.fetchMetadata(url);
  const directory = scheduler.getAssetDirectory(waiting.id);
  const original = await readFile(path.join(directory, 'media.info.json'));
  await scheduler.close();
  const missing = path.join(root, 'missing.exe');
  let probes = 0;
  const restored = await open({ tools: { ...tools, ytDlp: missing, ffmpeg: missing, node: missing } }, async (request) => {
    assert.ok(request.args.includes('-show_entries')); probes++; return probe(request);
  });
  const ready = await restored.attachLocalMedia(waiting.id, source);
  assert.equal(ready.state, 'READY'); assert.equal(ready.id, waiting.id); assert.equal(probes, 1);
  assert.deepEqual(await readFile(source), mediaBytes);
  assert.deepEqual(await readFile(path.join(directory, ready.asset.video.file)), mediaBytes);
  assert.deepEqual(await readFile(path.join(directory, 'media.info.json')), original);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')).video.sha256, ready.asset.video.sha256);
  await assert.rejects(restored.attachLocalMedia(waiting.id, source), { code: 'INVALID_STATE' });
});
test('invalid source path/type and failed ffprobe leave metadata awaiting and allow another attachment', async (t) => {
  let failProbe = true;
  const { scheduler, source, root } = await fixture(t, {}, async (request) => {
    if (request.args.includes('-show_entries')) return failProbe ? { exitCode: 1, stderr: 'corrupt file' } : probe(request);
    return metadataRunner(request);
  });
  const waiting = await scheduler.fetchMetadata(url);
  await assert.rejects(scheduler.attachLocalMedia(waiting.id, `${source}.part`), { code: 'INVALID_MEDIA', message: '本地媒体不可用，请选择已下载完成的非空 MP4 文件。' });
  const empty = path.join(root, 'empty.mp4'); await writeFile(empty, '');
  const directory = path.join(root, 'directory.mp4'); await mkdir(directory);
  for (const input of [empty, directory, path.join(root, 'missing.mp4'), source]) {
    const result = await scheduler.attachLocalMedia(waiting.id, input);
    assert.equal(result.state, 'AWAITING_MEDIA'); assert.ok(result.error);
    await access(path.join(scheduler.getAssetDirectory(waiting.id), 'media.info.json'));
    await assert.rejects(access(path.join(scheduler.getAssetDirectory(waiting.id), 'manifest.json')), { code: 'ENOENT' });
  }
  failProbe = false;
  assert.equal((await scheduler.attachLocalMedia(waiting.id, source)).state, 'READY');
  assert.deepEqual(await readFile(source), mediaBytes);
});
test('duplicate attachment is rejected immediately and cancelling a running attachment preserves metadata', async (t) => {
  let entered;
  const probing = new Promise((resolve) => { entered = resolve; });
  const { scheduler, source } = await fixture(t, {}, async (request) => {
    if (!request.args.includes('-show_entries')) return metadataRunner(request);
    entered();
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  });
  const waiting = await scheduler.fetchMetadata(url);
  const attachment = scheduler.attachLocalMedia(waiting.id, source);
  await assert.rejects(scheduler.attachLocalMedia(waiting.id, source), { code: 'INVALID_STATE', message: '任务未处于等待媒体状态，或已有媒体绑定操作正在进行。' });
  await probing; await scheduler.cancel(waiting.id);
  const result = await attachment;
  assert.equal(result.state, 'AWAITING_MEDIA'); assert.equal(result.error.code, 'CANCELLED');
  await scheduler.close();
  assert.equal(scheduler.getTask(waiting.id).state, 'AWAITING_MEDIA');
});
test('metadata deadline is independent of video timeout, keeps partial info, and retries remain metadata-only', async (t) => {
  let fail = true;
  const { scheduler } = await fixture(t, { timeoutMs: 10_000, metadataTimeoutMs: 80 }, async (request) => {
    assert.ok(request.args.includes('--skip-download'));
    assert.equal(request.args[request.args.indexOf('--retries') + 1], '0');
    if (!fail) return metadataRunner(request);
    await writeFile(path.join(request.cwd, 'media.info.json'), JSON.stringify(raw));
    if (request.signal.aborted) throw request.signal.reason;
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  });
  const failed = await scheduler.fetchMetadata(url);
  assert.equal(failed.error.code, 'TIMEOUT');
  await access(path.join(scheduler.getWorkDirectory(failed.id), 'media.info.json'));
  fail = false;
  const retried = await scheduler.retry(failed.id, { timeoutMs: 1000 });
  assert.equal((await scheduler.waitFor(retried.id)).state, 'AWAITING_MEDIA');
});
test('missing cover is not published as valid metadata', async (t) => {
  const { scheduler } = await fixture(t, {}, async (request) => {
    await writeFile(path.join(request.cwd, 'media.info.json'), JSON.stringify(raw));
    return { exitCode: 0, stderr: '' };
  });
  const failed = await scheduler.fetchMetadata(url);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'INVALID_OUTPUT');
  await assert.rejects(access(scheduler.getAssetDirectory(failed.id)), { code: 'ENOENT' });
});
test('interrupted metadata/attachment and full-manifest journal gaps recover without network requests', async (t) => {
  const { scheduler, source, dataDirectory, open } = await fixture(t);
  const a = await scheduler.fetchMetadata(url);
  const b = await scheduler.fetchMetadata(url);
  const c = await scheduler.fetchMetadata(url);
  await scheduler.attachLocalMedia(c.id, source);
  await scheduler.close();
  for (const [task, state] of [[a, 'finalizing'], [b, 'attaching'], [c, 'AWAITING_MEDIA']]) {
    const file = path.join(dataDirectory, 'jobs', `${task.id}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.state = state; delete record.asset;
    await writeFile(file, JSON.stringify(record));
  }
  const restored = await open({}, async () => { throw new Error('no automatic network access'); });
  assert.equal(restored.getTask(a.id).state, 'AWAITING_MEDIA');
  assert.equal(restored.getTask(b.id).state, 'AWAITING_MEDIA');
  assert.equal(restored.getTask(b.id).error.code, 'INTERRUPTED');
  assert.equal(restored.getTask(c.id).state, 'READY');
});
test('attachment commit failure retains orphan video and metadata; retry does not overwrite either', async (t) => {
  const { scheduler, source } = await fixture(t);
  const waiting = await scheduler.fetchMetadata(url);
  const commit = scheduler.store.commitAttachment.bind(scheduler.store);
  let orphan;
  scheduler.store.commitAttachment = async (id, staging, manifest) => {
    orphan = path.join(scheduler.getAssetDirectory(id), manifest.video.file);
    await rename(path.join(staging, 'media.mp4'), orphan);
    throw new FetcherError('PERSISTENCE_ERROR');
  };
  const failed = await scheduler.attachLocalMedia(waiting.id, source);
  assert.equal(failed.state, 'AWAITING_MEDIA'); assert.equal(failed.error.code, 'PERSISTENCE_ERROR');
  await access(orphan);
  scheduler.store.commitAttachment = commit;
  const ready = await scheduler.attachLocalMedia(waiting.id, source);
  assert.equal(ready.state, 'READY');
  assert.notEqual(path.join(scheduler.getAssetDirectory(ready.id), ready.asset.video.file), orphan);
  assert.deepEqual(await readFile(orphan), mediaBytes);
});
test('closing a queued attachment restores AWAITING_MEDIA and never starts copying', async (t) => {
  const { scheduler, source } = await fixture(t, { concurrency: 1 }, async (request) => {
    if (request.args.includes('--skip-download')) return metadataRunner(request);
    if (request.signal.aborted) throw request.signal.reason;
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  });
  const waiting = await scheduler.fetchMetadata(url);
  await scheduler.enqueue({ url });
  const attachment = scheduler.attachLocalMedia(waiting.id, source);
  await scheduler.close();
  assert.equal((await attachment).state, 'AWAITING_MEDIA');
  await assert.rejects(access(scheduler.getWorkDirectory(waiting.id)), { code: 'ENOENT' });
  await assert.rejects(scheduler.attachLocalMedia(waiting.id, source), { code: 'SCHEDULER_CLOSED' });
});

test('immediate attachment cancellation waits for preflight and never loses awaiting metadata', async (t) => {
  const { scheduler, source } = await fixture(t);
  const waiting = await scheduler.fetchMetadata(url);
  const attaching = scheduler.attachLocalMedia(waiting.id, source);
  await scheduler.cancel(waiting.id);
  const result = await attaching;
  assert.equal(result.state, 'AWAITING_MEDIA'); assert.equal(result.error.code, 'CANCELLED');
  assert.equal((await scheduler.attachLocalMedia(waiting.id, source)).state, 'READY');
});
test('waitFor called immediately after attachment does not return the stale awaiting snapshot', async (t) => {
  const { scheduler, source } = await fixture(t);
  const waiting = await scheduler.fetchMetadata(url);
  const attaching = scheduler.attachLocalMedia(waiting.id, source);
  assert.equal((await scheduler.waitFor(waiting.id)).state, 'READY');
  assert.equal((await attaching).state, 'READY');
});

test('a renamed non-MP4 container cannot become READY merely by having an mp4 extension', async (t) => {
  const { scheduler, source } = await fixture(t, {}, async (request) => {
    if (!request.args.includes('-show_entries')) return metadataRunner(request);
    request.onLine('{"streams":[{"codec_type":"video"}],"format":{"duration":"1","format_name":"matroska,webm"}}');
    return { exitCode: 0, stderr: '' };
  });
  const waiting = await scheduler.fetchMetadata(url);
  const result = await scheduler.attachLocalMedia(waiting.id, source);
  assert.equal(result.state, 'AWAITING_MEDIA'); assert.equal(result.error.code, 'INVALID_OUTPUT');
});
