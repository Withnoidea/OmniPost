import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadScheduler, FetcherError, normalizeSource, normalizeProxy, resolvePortableTools } from '../dist/packages/core/src/index.js';
import { buildArguments, parseProgress, PROGRESS_PREFIX, FILE_PREFIX } from '../dist/packages/core/src/fetcher/downloader.js';
import { classifyDownloadError } from '../dist/packages/core/src/fetcher/errors.js';

const url = 'https://www.youtube.com/watch?v=BaW_jenozKc';
const tools = { ytDlp: process.execPath, node: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath };
const options = { tools, socketTimeoutSeconds: 15, retries: 2 };
const metadata = { id: 'BaW_jenozKc', title: '中文标题 🌏 日本語', description: 'Original\n多语言简介', uploader: 'Creator', duration: 1, language: 'en', tags: ['one', '话题'], subtitles: { en: [], 'zh-Hans': [] }, automatic_captions: { ja: [] } };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'omnipost-test-'));
  return root;
}
function isProbe(request) { return request.args.includes('-show_entries'); }
function probe(request) { request.onLine('{"streams":[{"codec_type":"video"}],"format":{"duration":"1.0"}}'); return { exitCode: 0, stderr: '' }; }
async function writeMedia(request, { cover = true, raw = metadata } = {}) {
  await writeFile(path.join(request.cwd, 'media.mp4'), Buffer.from('fixture video'));
  if (cover) await writeFile(path.join(request.cwd, 'cover.jpg'), Buffer.from('fixture cover'));
  await writeFile(path.join(request.cwd, 'media.info.json'), JSON.stringify(raw));
  request.onLine(`${PROGRESS_PREFIX}{"downloaded_bytes":50,"total_bytes":100,"speed":25,"eta":2}`);
  request.onLine(`${FILE_PREFIX}${JSON.stringify(path.join(request.cwd, 'media.mp4'))}`);
  return { exitCode: 0, stderr: '' };
}
const successful = async (request) => isProbe(request) ? probe(request) : writeMedia(request);
async function create(t, overrides = {}, runner = successful) {
  const dataDirectory = await fixture();
  const scheduler = await DownloadScheduler.create({ dataDirectory, tools, ...overrides }, runner);
  t.after(async () => {
    await scheduler.close();
    assert.equal(path.dirname(dataDirectory), tmpdir());
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { scheduler, dataDirectory };
}

test('YouTube/TikTok URLs normalize to a single video without tracking/query secrets', () => {
  for (const input of ['https://youtu.be/BaW_jenozKc?si=secret', 'https://m.youtube.com/shorts/BaW_jenozKc', `${url}&list=PL123&index=2`]) assert.deepEqual(normalizeSource(input), { url, platform: 'youtube' });
  assert.equal(normalizeSource('https://www.tiktok.com/@creator/video/123456?token=secret').url, 'https://www.tiktok.com/@creator/video/123456');
  assert.equal(normalizeSource('https://vm.tiktok.com/ABC123/').platform, 'tiktok');
  for (const input of ['file:///C:/private', 'http://www.youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com.evil.com/watch?v=BaW_jenozKc', 'https://user:password@youtube.com/watch?v=BaW_jenozKc', 'https://www.youtube.com/playlist?list=xx', 'https://youtu.be/no', '--exec=evil', `${url}\n--exec=evil`, 'https://localhost/video/1']) {
    assert.throws(() => normalizeSource(input), { code: 'INVALID_URL' });
  }
});
test('proxy validation handles HTTP/SOCKS credentials without accepting argument injection', () => {
  for (const input of ['http://127.0.0.1:7890', 'https://user:p%40ss@localhost:8443', 'socks5://127.0.0.1:1080', 'socks5h://user:pass@host:1080']) assert.ok(normalizeProxy(input).startsWith(input));
  assert.equal(normalizeProxy(), ''); assert.equal(normalizeProxy(''), '');
  for (const input of ['ftp://localhost', 'http://host/path', 'http://host?x=y', 'http://host/#token', 'socks5://host:65536', 'http://bad%ZZ:pass@host', 'http://host\n--exec=evil']) assert.throws(() => normalizeProxy(input), { code: 'INVALID_PROXY' });
});
test('arguments explicitly disable ambient config/proxy/PATH runtime and select deterministic outputs', () => {
  const args = buildArguments(url, '', options);
  assert.equal(args[args.indexOf('--proxy') + 1], '');
  assert.ok(args.includes('--ignore-config')); assert.ok(args.includes('--no-playlist'));
  assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
  assert.deepEqual(args.slice(-2), ['--', url]);
  assert.ok(args.includes('thumbnail:cover.%(ext)s'));
  const resources = resolvePortableTools('resources');
  for (const file of Object.values(resources)) assert.ok(path.isAbsolute(file));
});
test('progress is structured, bounded and tolerant of missing totals / malformed output', () => {
  assert.equal(parseProgress('noise'), undefined);
  assert.equal(parseProgress(`${PROGRESS_PREFIX}not-json`), undefined);
  assert.equal(parseProgress(`${PROGRESS_PREFIX}{"downloaded_bytes":150,"total_bytes":100}`).percent, 100);
  assert.deepEqual(parseProgress(`${PROGRESS_PREFIX}{"downloaded_bytes":5,"speed":null}`), { phase: 'download', downloadedBytes: 5 });
  assert.deepEqual(parseProgress(`${PROGRESS_PREFIX}{"downloaded_bytes":-2,"total_bytes":0}`), { phase: 'download', downloadedBytes: 0 });
});
test('classifies common failures and never includes raw stderr secrets', () => {
  for (const [text, code] of [['HTTP Error 429', 'RATE_LIMITED'], ['Sign in to confirm you are not a bot', 'AUTH_REQUIRED'], ['Proxy connection refused http://u:secret@localhost', 'NETWORK_ERROR'], ['Video unavailable', 'UNAVAILABLE'], ['unknown secret failure', 'DOWNLOAD_FAILED']]) {
    const error = classifyDownloadError(text);
    assert.equal(error.code, code); assert.ok(!JSON.stringify(error).includes('secret'));
  }
});
test('success atomically commits media, cover, raw + normalized metadata and SHA256 manifest', async (t) => {
  const events = [];
  const { scheduler, dataDirectory } = await create(t, { onEvent: (event) => events.push(event) });
  const task = await scheduler.enqueue({ url, proxy: 'http://user:secret@127.0.0.1:7890' });
  const done = await scheduler.waitFor(task.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.asset.metadata.title, metadata.title);
  assert.deepEqual(done.asset.metadata.subtitleLanguages, ['en', 'zh-Hans']);
  assert.match(done.asset.video.sha256, /^[a-f0-9]{64}$/);
  assert.equal(done.asset.video.bytes, 13);
  assert.deepEqual((await readdir(scheduler.getAssetDirectory(task.id))).sort(), ['cover.jpg', 'manifest.json', 'media.info.json', 'media.mp4', 'metadata.json']);
  await assert.rejects(access(scheduler.getWorkDirectory(task.id)), { code: 'ENOENT' });
  const journal = await readFile(path.join(dataDirectory, 'jobs', `${task.id}.json`), 'utf8');
  assert.equal(JSON.parse(journal).state, 'completed');
  assert.ok(!journal.includes('secret')); assert.ok(!JSON.stringify(events).includes('secret'));
  assert.deepEqual(events.filter((event) => event.type === 'state').map((event) => event.task.state), ['queued', 'downloading', 'finalizing', 'completed']);
  assert.equal(events.filter((event) => event.type === 'success').length, 1);
});
test('concurrency bound is enforced and all queued tasks complete', async (t) => {
  let active = 0; let maximum = 0;
  const { scheduler } = await create(t, { concurrency: 2 }, async (request) => {
    if (isProbe(request)) return probe(request);
    active++; maximum = Math.max(maximum, active);
    await delay(30); const result = await writeMedia(request); active--; return result;
  });
  const jobs = await Promise.all(Array.from({ length: 5 }, () => scheduler.enqueue({ url })));
  const tasks = await Promise.all(jobs.map((job) => scheduler.waitFor(job.id)));
  assert.equal(maximum, 2); assert.ok(tasks.every((task) => task.state === 'completed'));
});
test('partial download failure keeps workspace and retry creates isolated fresh task', async (t) => {
  let calls = 0;
  const { scheduler } = await create(t, {}, async (request) => {
    if (isProbe(request)) return probe(request);
    if (calls++ === 0) { await writeFile(path.join(request.cwd, 'media.mp4.part'), 'partial'); return { exitCode: 1, stderr: 'proxy refused http://user:secret@host' }; }
    assert.equal(request.args[request.args.indexOf('--proxy') + 1], '');
    return writeMedia(request);
  });
  const initial = await scheduler.enqueue({ url, proxy: 'http://user:secret@host' });
  const failed = await scheduler.waitFor(initial.id);
  assert.equal(failed.error.code, 'NETWORK_ERROR');
  assert.equal(await readFile(path.join(scheduler.getWorkDirectory(initial.id), 'media.mp4.part'), 'utf8'), 'partial');
  const retry = await scheduler.retry(initial.id);
  assert.notEqual(retry.id, initial.id);
  assert.equal((await scheduler.waitFor(retry.id)).state, 'completed');
  await access(scheduler.getWorkDirectory(initial.id));
});
const hanging = async (request) => {
  await writeFile(path.join(request.cwd, 'media.mp4.part'), 'partial');
  if (request.signal.aborted) throw request.signal.reason;
  return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
};
test('timeout aborts the runner, retains partials and produces TIMEOUT', async (t) => {
  const { scheduler } = await create(t, { timeoutMs: 60 }, hanging);
  const task = await scheduler.enqueue({ url });
  assert.equal((await scheduler.waitFor(task.id)).error.code, 'TIMEOUT');
  await access(path.join(scheduler.getWorkDirectory(task.id), 'media.mp4.part'));
});
test('queued and running cancellation never emit success', async (t) => {
  let calls = 0; let success = 0;
  const { scheduler } = await create(t, { concurrency: 1, onSuccess: () => success++ }, async (request) => { calls++; return hanging(request); });
  const a = await scheduler.enqueue({ url }); const b = await scheduler.enqueue({ url });
  await scheduler.cancel(b.id); await scheduler.cancel(a.id);
  assert.equal((await scheduler.waitFor(a.id)).state, 'cancelled');
  assert.equal((await scheduler.waitFor(b.id)).state, 'cancelled');
  assert.ok(calls <= 1); assert.equal(success, 0);
});
test('closing cancels pending enqueue and running work, releases lock, and is idempotent', async (t) => {
  const { scheduler, dataDirectory } = await create(t, {}, hanging);
  const enqueuing = scheduler.enqueue({ url });
  const close = scheduler.close();
  const task = await enqueuing;
  await close; await scheduler.close();
  assert.equal((await scheduler.waitFor(task.id)).state, 'cancelled');
  await assert.rejects(scheduler.enqueue({ url }), { code: 'SCHEDULER_CLOSED' });
  const next = await DownloadScheduler.create({ dataDirectory, tools }, successful);
  await next.close();
});
test('observer exceptions and mutations cannot corrupt scheduling', async (t) => {
  const { scheduler } = await create(t, {
    onEvent: (event) => { if ('task' in event) event.task.state = 'failed'; throw new Error('UI failure'); },
    onProgress: async () => { throw new Error(); }, onSuccess: async () => { throw new Error(); },
  });
  const task = await scheduler.enqueue({ url });
  assert.equal((await scheduler.waitFor(task.id)).state, 'completed');
  const copy = scheduler.getTask(task.id); copy.state = 'failed';
  assert.equal(scheduler.getTask(task.id).state, 'completed');
});
test('missing/invalid output, ffprobe failure and missing metadata never commit assets', async (t) => {
  for (const scenario of ['no-cover', 'bad-metadata', 'bad-probe', 'path-escape', 'no-video']) {
    const { scheduler } = await create(t, {}, async (request) => {
      if (isProbe(request)) return scenario === 'bad-probe' ? { exitCode: 1, stderr: 'invalid media' } : probe(request);
      if (scenario === 'no-video') return { exitCode: 0, stderr: '' };
      const result = await writeMedia(request, { cover: scenario !== 'no-cover', raw: scenario === 'bad-metadata' ? {} : metadata });
      if (scenario === 'path-escape') request.onLine(`${FILE_PREFIX}${JSON.stringify(path.resolve(request.cwd, '../media.mp4'))}`);
      return result;
    });
    const task = await scheduler.enqueue({ url }); const result = await scheduler.waitFor(task.id);
    assert.equal(result.error.code, 'INVALID_OUTPUT', scenario);
    await assert.rejects(access(scheduler.getAssetDirectory(task.id)), { code: 'ENOENT' });
    await scheduler.close();
  }
});
test('restart preserves completed assets, marks in-flight tasks interrupted, and recovers commit/journal gap', async (t) => {
  const { scheduler, dataDirectory } = await create(t);
  const jobs = await Promise.all(Array.from({ length: 3 }, () => scheduler.enqueue({ url })));
  await Promise.all(jobs.map((job) => scheduler.waitFor(job.id))); await scheduler.close();
  const [complete, interrupted, commitGap] = jobs;
  for (const job of [interrupted, commitGap]) {
    const file = path.join(dataDirectory, 'jobs', `${job.id}.json`);
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.state = 'finalizing'; delete value.asset;
    await writeFile(file, JSON.stringify(value));
  }
  await rename(scheduler.getAssetDirectory(interrupted.id), scheduler.getWorkDirectory(interrupted.id));
  const restored = await DownloadScheduler.create({ dataDirectory, tools }, async () => { throw new Error('must not auto-run'); });
  assert.equal(restored.getTask(complete.id).state, 'completed');
  assert.equal(restored.getTask(interrupted.id).error.code, 'INTERRUPTED');
  assert.equal(restored.getTask(commitGap.id).state, 'completed');
  await access(restored.getWorkDirectory(interrupted.id));
  await restored.close();
});
test('single data-directory owner and invalid options fail early', async (t) => {
  const { scheduler, dataDirectory } = await create(t);
  await assert.rejects(DownloadScheduler.create({ dataDirectory, tools }), { code: 'STORE_LOCKED' });
  await assert.rejects(DownloadScheduler.create({ dataDirectory, tools, concurrency: 0 }), { code: 'INVALID_OPTIONS' });
  const withoutTools = await DownloadScheduler.create({ dataDirectory: path.join(dataDirectory, 'missing-tools'), tools: { ...tools, ytDlp: path.join(dataDirectory, 'missing.exe') } });
  try { await assert.rejects(withoutTools.enqueue({ url }), { code: 'TOOL_NOT_FOUND' }); }
  finally { await withoutTools.close(); }
  await assert.rejects(scheduler.enqueue({ url, timeoutMs: NaN }), { code: 'INVALID_OPTIONS' });
  assert.equal(scheduler.listTasks().length, 0);
});
test('journal write failure is explicit and does not emit success or lose committed assets', async (t) => {
  let successes = 0;
  const { scheduler, dataDirectory } = await create(t, { onSuccess: () => successes++ }, async (request) => {
    if (isProbe(request)) {
      // Replace the task journal with a directory to deterministically fail the final rename.
      const id = path.basename(request.cwd);
      const file = path.join(dataDirectory, 'jobs', `${id}.json`);
      await rename(file, `${file}.preserved`); await mkdir(file);
      return probe(request);
    }
    return writeMedia(request);
  });
  const task = await scheduler.enqueue({ url }); const failed = await scheduler.waitFor(task.id);
  assert.equal(failed.error.code, 'PERSISTENCE_ERROR'); assert.equal(successes, 0);
  await access(path.join(scheduler.getAssetDirectory(task.id), 'manifest.json'));
});

test('close waits for a concurrent queued-cancellation journal write before releasing ownership', async (t) => {
  const { scheduler, dataDirectory } = await create(t, { concurrency: 1 }, hanging);
  await scheduler.enqueue({ url });
  const queued = await scheduler.enqueue({ url });
  const save = scheduler.store.save.bind(scheduler.store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  scheduler.store.save = async (task) => {
    if (task.id === queued.id && task.state === 'cancelled') await gate;
    return save(task);
  };
  const cancellation = scheduler.cancel(queued.id);
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await delay(30);
  assert.equal(closed, false);
  release();
  await Promise.all([cancellation, closing]);
  const restored = await DownloadScheduler.create({ dataDirectory, tools }, successful);
  try { assert.equal(restored.getTask(queued.id).state, 'cancelled'); }
  finally { await restored.close(); }
});
