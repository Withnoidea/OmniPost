import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DownloadScheduler, resolvePortableTools } from '../dist/packages/core/src/index.js';
import { runProcess } from '../dist/packages/core/src/fetcher/process.js';

const tools = resolvePortableTools(fileURLToPath(new URL('../resources', import.meta.url)));
let available = true;
try { for (const tool of Object.values(tools)) await access(tool); } catch { available = false; }

test('portable tools verify full download, metadata-only zero-video requests, API attachment and CLI attachment offline', { skip: !available, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omnipost-integration-'));
  let scheduler;
  const requests = [];
  let server;
  let diagnostic = '';
  const progress = [];
  const oldPath = process.env.PATH;
  try {
    const video = path.join(directory, 'fixture.mp4');
    const cover = path.join(directory, 'fixture.png');
    const audio = path.join(directory, 'fixture.m4a');
    for (const args of [
      ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video],
      ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:a', 'aac', audio],
      ['-f', 'lavfi', '-i', 'color=c=red:s=160x90', '-frames:v', '1', cover],
    ]) {
      const result = spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr);
    }
    const media = await readFile(video); const image = await readFile(cover); const sound = await readFile(audio);
    server = createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers['proxy-authorization'] });
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('omnipost:fixture-secret').toString('base64')}`) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="OmniPost"' }); res.end(); return;
      }
      const target = new URL(req.url);
      const isCover = target.pathname === '/cover.png';
      const body = isCover ? image : target.pathname === '/audio.m4a' ? sound : media;
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': isCover ? 'image/png' : 'video/mp4' });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const info = path.join(directory, 'source.info.json');
    await writeFile(info, JSON.stringify({
      id: 'BaW_jenozKc', title: '自制测试视频 🌏', description: 'Offline integration, original synthetic media.',
      _type: 'video', extractor: 'generic', extractor_key: 'Generic',
      webpage_url: 'https://www.youtube.com/watch?v=BaW_jenozKc',
      duration: 1,
      formats: [
        { url: 'http://media.omnipost.invalid/audio.m4a', ext: 'm4a', protocol: 'http', format_id: 'audio', vcodec: 'none', acodec: 'aac', abr: 128 },
        { url: 'http://media.omnipost.invalid/video.mp4', ext: 'mp4', protocol: 'http', format_id: 'video', vcodec: 'h264', acodec: 'none', width: 160, height: 90, fps: 10 },
      ],
      thumbnails: [{ id: 'original', url: 'http://media.omnipost.invalid/cover.png', ext: 'png' }],
    }));
    process.env.PATH = '';
    scheduler = await DownloadScheduler.create({ dataDirectory: path.join(directory, 'data'), tools, timeoutMs: 30_000, onProgress: (_id, event) => progress.push(event) }, async (request) => {
      if (request.executable !== tools.ytDlp) return runProcess(request);
      // Replace only source extraction with a saved info fixture; all download/proxy/output arguments
      // and the actual yt-dlp/FFmpeg processes are exercised. No source-site network is contacted.
      const args = [...request.args.slice(0, -2), '--load-info-json', info];
      const result = await runProcess({ ...request, args });
      diagnostic = result.stderr;
      return result;
    });
    const job = await scheduler.enqueue({ url: 'https://youtu.be/BaW_jenozKc', proxy: `http://omnipost:fixture-secret@127.0.0.1:${port}` });
    const done = await scheduler.waitFor(job.id);
    assert.equal(done.state, 'completed', `${JSON.stringify(done.error)} ${diagnostic.replaceAll('fixture-secret', '[redacted]')}`);
    assert.ok(progress.some((event) => event.downloadedBytes > 0), 'real yt-dlp progress must parse');
    assert.equal(done.asset.metadata.title, '自制测试视频 🌏');
    assert.ok(done.asset.video.bytes > media.length, 'audio and video should be merged');
    assert.equal(done.asset.thumbnail.file, 'cover.png');
    assert.deepEqual(await readFile(path.join(scheduler.getAssetDirectory(job.id), 'cover.png')), image, 'original cover bytes must be preserved');
    assert.ok(requests.some((request) => request.url.endsWith('/audio.m4a')));
    assert.ok(requests.some((request) => request.url.endsWith('/cover.png')));
    assert.ok(requests.some((request) => request.url.endsWith('/video.mp4')));
    const rawInfo = await readFile(path.join(scheduler.getAssetDirectory(job.id), 'media.info.json'), 'utf8');
    assert.ok(!rawInfo.includes('fixture-secret'));
    const manifest = JSON.parse(await readFile(path.join(scheduler.getAssetDirectory(job.id), 'manifest.json'), 'utf8'));
    assert.equal(manifest.video.sha256, done.asset.video.sha256);

    requests.length = 0;
    const metadataOnly = await scheduler.fetchMetadata('https://youtu.be/BaW_jenozKc', {
      proxy: `http://omnipost:fixture-secret@127.0.0.1:${port}`,
    });
    assert.equal(metadataOnly.state, 'AWAITING_MEDIA', diagnostic);
    assert.ok(requests.some((request) => request.url.endsWith('/cover.png')));
    assert.ok(requests.every((request) => !request.url.endsWith('/video.mp4') && !request.url.endsWith('/audio.m4a')), 'metadata mode must make zero video/audio requests');
    const ready = await scheduler.attachLocalMedia(metadataOnly.id, video);
    assert.equal(ready.state, 'READY');
    assert.deepEqual(await readFile(path.join(scheduler.getAssetDirectory(ready.id), ready.asset.video.file)), media);

    const cliWaiting = await scheduler.fetchMetadata('https://youtu.be/BaW_jenozKc', {
      proxy: `http://omnipost:fixture-secret@127.0.0.1:${port}`,
    });
    assert.equal(cliWaiting.state, 'AWAITING_MEDIA');
    await scheduler.close();
    const requestsBeforeAttach = requests.length;
    const cli = fileURLToPath(new URL('../dist/tools/fetch.js', import.meta.url));
    const attached = spawnSync(process.execPath, [cli, '--attach', cliWaiting.id, video, '--data', path.join(directory, 'data')], {
      cwd: tmpdir(), windowsHide: true, shell: false, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(attached.status, 0, attached.stderr);
    const receipt = JSON.parse(attached.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(receipt.state, 'READY'); assert.equal(receipt.taskId, cliWaiting.id);
    assert.equal(requests.length, requestsBeforeAttach, 'manual attachment must not access the network');
    assert.deepEqual(await readFile(video), media, 'the IDM source is never moved or changed');

  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await scheduler?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

test('compiled CLI resolves bundled resources without relying on the caller working directory', { skip: !available, timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omnipost-cli-'));
  try {
    const cli = fileURLToPath(new URL('../dist/tools/fetch.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--list', '--data', directory], {
      cwd: tmpdir(), windowsHide: true, shell: false, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});
