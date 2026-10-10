import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DownloadScheduler } from '../dist/packages/core/src/fetcher/scheduler.js';
import { CookieStore, serializeCookies, cookieDomainAllowed } from '../dist/packages/core/src/fetcher/cookies.js';
import { validateManual } from '../dist/packages/core/src/fetcher/manual.js';
import { resolveRewriteOptions, requestRewrite, fetchModels, validateHeaders } from '../dist/packages/core/src/rewriter/client.js';
import { extractSourceText } from '../dist/packages/core/src/rewriter/metadata.js';
import { AIRewriter } from '../dist/packages/core/src/rewriter/rewriter.js';
import { MediaProcessor } from '../dist/packages/core/src/processor/processor.js';
import { resolvePortableTools } from '../dist/packages/core/src/fetcher/config.js';
import { runProcess } from '../dist/packages/core/src/fetcher/process.js';
import { TARGET_PLATFORMS } from '../dist/packages/core/src/rewriter/types.js';
const mockTools = { ytDlp: process.execPath, ffmpeg: process.execPath, ffprobe: process.execPath, node: process.execPath };
const manual = { title: '手动创作', description: '完整的创作介绍', tags: ['灵感'], author: '创作者' };
const copy = { title: '今天的创作｜记录灵感', body: '认真分享一份创作过程。', tags: ['创作', '灵感', '日常'], hook: '一起看看', category: '生活' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const probe = async request => { request.onLine('{"streams":[{"codec_type":"video"}],"format":{"duration":"1","format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}'); return { exitCode: 0, stderr: '' }; };
const closers = new Map();
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'omni-upgrade-'));
  closers.set(root, []);
  t.after(async () => { for (const close of closers.get(root)) await close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  return root;
}
const cookie = { domain: '.youtube.com', path: '/', name: 'SID', value: 'private-cookie', secure: true, httpOnly: true };

test('cookie serialization filters platform/expiry, preserves HttpOnly/session flags and rejects injection', () => {
  const data = serializeCookies('youtube', [cookie, { ...cookie, domain: 'evilyoutube.com' }, { ...cookie, domain: '.tiktok.com' }, { ...cookie, name: 'expired', expirationDate: 1 }]);
  assert.match(data, /#HttpOnly_\.youtube.com\tTRUE\t\/\tTRUE\t0\tSID\tprivate-cookie/);
  assert.ok(!data.includes('expired')); assert.ok(!data.includes('evilyoutube')); assert.ok(!data.includes('tiktok'));
  assert.equal(cookieDomainAllowed('youtube', 'youtube.com.attacker.test'), false);
  assert.throws(() => serializeCookies('youtube', [{ ...cookie, value: 'secret\ninjected' }]), { code: 'INVALID_OPTIONS' });
  assert.throws(() => serializeCookies('tiktok', [cookie]), { code: 'AUTH_REQUIRED' });
});
test('AUTH_REQUIRED retry automatically carries an isolated cookie jar and never publishes secrets', async t => {
  const root = await fixture(t); const events = []; let first = true;
  const scheduler = await DownloadScheduler.create({ dataDirectory: root, tools: mockTools, onEvent: event => events.push(event) }, async request => {
    if (first) { first = false; return { exitCode: 1, stderr: 'Sign in to confirm you are not a bot' }; }
    const index = request.args.indexOf('--cookies'); assert.ok(index >= 0);
    const jar = request.args[index + 1]; assert.ok(jar.includes('request-')); assert.match(await readFile(jar, 'utf8'), /private-cookie/);
    await writeFile(jar, 'yt-dlp rewrites its own jar');
    await writeFile(path.join(request.cwd, 'media.info.json'), JSON.stringify({ id: 'BaW_jenozKc', title: 'Recovered' }));
    await writeFile(path.join(request.cwd, 'cover.png'), png); return { exitCode: 0, stderr: '' };
  });
  closers.get(root).push(() => scheduler.close());
  const failed = await scheduler.fetchMetadata('https://youtu.be/BaW_jenozKc'); assert.equal(failed.error.code, 'AUTH_REQUIRED');
  const cookies = new CookieStore(root); await cookies.save('youtube', [cookie]);
  const retry = await scheduler.retry(failed.id); const ready = await scheduler.waitFor(retry.id);
  assert.equal(ready.state, 'AWAITING_MEDIA'); assert.notEqual(ready.id, failed.id);
  assert.equal(scheduler.getTask(failed.id).error.code, 'AUTH_REQUIRED');
  assert.match(await readFile(await cookies.get('youtube'), 'utf8'), /private-cookie/);
  assert.deepEqual(await readdir(path.join(root, 'cookies')), ['youtube.txt']);
  assert.ok(!JSON.stringify(events).includes('private-cookie'));
  assert.ok(!(await readFile(path.join(root, 'jobs', ready.id + '.json'), 'utf8')).includes('cookies'));
  assert.ok(!(await readdir(scheduler.getAssetDirectory(ready.id))).some(file => file.includes('cookie')));
});
test('manual metadata needs no source URL or downloader and later attachment enters durable READY', async t => {
  const root = await fixture(t); let calls = 0;
  const options = { dataDirectory: root, tools: { ...mockTools, ytDlp: 'missing', ffmpeg: 'missing', node: 'missing' } };
  let scheduler = await DownloadScheduler.create(options, async request => { calls++; return probe(request); });
  closers.get(root).push(() => scheduler.close());
  const draft = await scheduler.createManual(manual); assert.equal(draft.state, 'AWAITING_MEDIA'); assert.equal(draft.platform, 'local'); assert.equal(calls, 0);
  const source = path.join(root, 'source.mp4'); await writeFile(source, 'mock mp4');
  const ready = await scheduler.attachLocalMedia(draft.id, source); assert.equal(ready.state, 'READY'); assert.equal(calls, 1);
  assert.equal(ready.asset.metadata.uploader, manual.author); assert.deepEqual(ready.asset.metadata.tags, manual.tags);
  assert.equal(await readFile(source, 'utf8'), 'mock mp4');
  await scheduler.close(); scheduler = await DownloadScheduler.create(options, probe);
  assert.equal(scheduler.getTask(ready.id).state, 'READY');
});
test('manual video/cover are copied and revisions do not mutate prior committed assets', async t => {
  const root = await fixture(t); const source = path.join(root, 'input.mp4'); const cover = path.join(root, 'input.png');
  await writeFile(source, 'mock mp4'); await writeFile(cover, png);
  const scheduler = await DownloadScheduler.create({ dataDirectory: root, tools: mockTools }, probe); closers.get(root).push(() => scheduler.close());
  const first = await scheduler.createManual({ ...manual, videoPath: source, coverPath: cover });
  assert.equal(first.state, 'READY');
  const second = await scheduler.createManual({ ...manual, title: '补全标题', videoPath: path.join(scheduler.getAssetDirectory(first.id), first.asset.video.file) });
  assert.equal(second.state, 'READY'); assert.notEqual(first.id, second.id);
  assert.equal(scheduler.getTask(first.id).asset.metadata.title, manual.title);
  assert.equal(second.asset.video.sha256, first.asset.video.sha256); assert.deepEqual(await readFile(cover), png);
});
test('invalid manual image/video and bad metadata never become READY; previous failure does not block recovery', async t => {
  const root = await fixture(t); const source = path.join(root, 'not-video.mp4'); const cover = path.join(root, 'fake.png');
  await writeFile(source, 'not video'); await writeFile(cover, '<html>not an image</html>');
  const scheduler = await DownloadScheduler.create({ dataDirectory: root, tools: mockTools }, async () => ({ exitCode: 1, stderr: 'invalid' })); closers.get(root).push(() => scheduler.close());
  const badCover = await scheduler.createManual({ ...manual, coverPath: cover }); assert.equal(badCover.state, 'failed'); assert.equal(badCover.asset, undefined);
  const badVideo = await scheduler.createManual({ ...manual, videoPath: source }); assert.equal(badVideo.state, 'failed'); assert.equal(badVideo.asset, undefined);
  const recovered = await scheduler.createManual(manual); assert.equal(recovered.state, 'AWAITING_MEDIA');
  assert.throws(() => validateManual({ ...manual, title: '' }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => validateManual({ ...manual, tags: ['a'.repeat(101)] }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => validateManual({ ...manual, videoPath: '../escape.mp4' }), { code: 'INVALID_MEDIA' });
});
test('manual READY asset feeds four-platform rewrite and real bundled FFmpeg without network', async t => {
  const root = await fixture(t); const tools = resolvePortableTools(path.resolve('resources'));
  const video = path.join(root, 'original.mp4');
  const encoded = await runProcess({ executable: tools.ffmpeg, args: ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=160x120:r=10', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], cwd: root, signal: new AbortController().signal, onLine() {} });
  assert.equal(encoded.exitCode, 0);
  const original = await readFile(video);
  const scheduler = await DownloadScheduler.create({ dataDirectory: path.join(root, 'data'), tools }); closers.get(root).push(() => scheduler.close());
  const task = await scheduler.createManual({ ...manual, videoPath: video }); assert.equal(task.state, 'READY');
  const writer = new AIRewriter({ dataDirectory: path.join(root, 'data'), baseURL: 'http://localhost:1234/v1', model: 'offline' }, async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(copy) } }] }));
  const rewritten = await writer.rewriteTask(task.id, [...TARGET_PLATFORMS]); assert.equal(rewritten.state, 'completed'); assert.equal(Object.keys(rewritten.document.platforms).length, 4);
  const processed = await new MediaProcessor({ dataDirectory: path.join(root, 'data'), tools }).processTask(task.id);
  assert.equal(processed.state, 'PROCESSED_READY'); assert.ok(processed.video.bytes > 0); assert.deepEqual(await readFile(video), original);
});
test('Anthropic native protocol separates system, uses x-api-key and accounts token usage', async () => {
  const options = resolveRewriteOptions({ protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'private-key', model: 'custom-claude', headers: { 'X-Workspace': 'creator' }, systemPrompt: '自然克制' });
  let usage;
  const result = await requestRewrite(extractSourceText(manual), 'douyin', options, async (url, request) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers['x-api-key'], 'private-key'); assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(request.body); assert.match(body.system, /自然克制/); assert.equal(body.messages[0].role, 'user'); assert.equal(body.response_format, undefined);
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(copy) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } });
  }, value => { usage = value; });
  assert.equal(result.model, 'custom-claude'); assert.deepEqual(usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
});
test('Anthropic truncation/refusal and provider errors are typed without secret response bodies', async () => {
  const options = resolveRewriteOptions({ protocol: 'anthropic', baseURL: 'https://gateway.example/v1', model: 'custom' });
  for (const stop_reason of ['max_tokens', 'refusal', 'tool_use']) await assert.rejects(requestRewrite(extractSourceText(manual), 'douyin', options, async () => Response.json({ content: [], stop_reason })), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchModels({ protocol: 'anthropic', baseURL: 'https://gateway.example/v1' }, async () => new Response('private secret body', { status: 401 })), error => error.code === 'AUTH_ERROR' && !error.message.includes('private'));
});
test('model fetching supports both protocol headers, custom base paths and arbitrary model ids', async () => {
  for (const protocol of ['openai', 'anthropic']) {
    const models = await fetchModels({ protocol, baseURL: 'https://gateway.example/proxy/v1/', apiKey: 'key', model: 'placeholder', headers: { 'x-workspace': 'a' } }, async (url, request) => {
      assert.equal(url, 'https://gateway.example/proxy/v1/models'); assert.equal(request.redirect, 'error');
      assert.equal(protocol === 'openai' ? request.headers.Authorization : request.headers['x-api-key'], protocol === 'openai' ? 'Bearer key' : 'key');
      assert.equal(request.headers['x-workspace'], 'a');
      return Response.json({ data: [{ id: 'custom/model:latest' }, { id: 'custom/model:latest' }, { id: 1 }, { id: 'a-model' }] });
    });
    assert.deepEqual(models, ['a-model', 'custom/model:latest']);
  }
});
test('model list failure remains recoverable by custom model; bounds and header security are enforced', async () => {
  const options = { baseURL: 'http://127.0.0.1:11434', model: 'any/custom' };
  await assert.rejects(fetchModels(options, async () => new Response('', { status: 404 })), { code: 'API_ERROR' });
  assert.equal(resolveRewriteOptions(options).model, 'any/custom');
  await assert.rejects(fetchModels(options, async () => Response.json({ data: [] })), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchModels(options, async () => new Response('x'.repeat(1024 * 1024 + 1))), { code: 'INVALID_RESPONSE' });
  for (const headers of [{ Host: 'attacker' }, { Authorization: 'secret' }, { Cookie: 'secret' }, { 'x-api-key': 'secret' }, { 'X-Test': 'a\r\nb' }, { 'X-Test': 1 }, []]) assert.throws(() => validateHeaders(headers), { code: 'INVALID_OPTIONS' });
  assert.throws(() => resolveRewriteOptions({ ...options, protocol: 'anthropic', temperature: 1.5 }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => resolveRewriteOptions({ ...options, baseURL: 'http://remote.example' }), { code: 'INVALID_OPTIONS' });
});
test('model fetch cancellation aborts transport and never returns provider details', async () => {
  const controller = new AbortController();
  const promise = fetchModels({ baseURL: 'http://localhost:11434/v1', signal: controller.signal }, async (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('private-network-details')), { once: true })));
  controller.abort(); await assert.rejects(promise, error => error.code === 'CANCELLED' && !error.message.includes('private'));
});
