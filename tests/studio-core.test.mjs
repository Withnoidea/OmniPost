import { test } from 'node:test';

import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { MediaProcessor, AIRewriter, collectAnalytics, resolvePortableTools, processingSettings } from '../dist/packages/core/src/index.js';

import { describeFile } from '../dist/packages/core/src/fetcher/store.js';

import { runProcess } from '../dist/packages/core/src/fetcher/process.js';

const tools = resolvePortableTools(path.resolve('resources'));

async function fixture(t, audio = true) {

  const root = await mkdtemp(path.join(tmpdir(), 'omni-studio-')); const id = randomUUID();

  const directory = path.join(root, 'assets', id); await mkdir(directory, { recursive: true });

  t.after(async () => { assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });

  const args = ['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25', ...(audio ? ['-f','lavfi','-i','sine=frequency=440:sample_rate=44100'] : []), '-t','2','-c:v','libx264','-threads','1', ...(audio ? ['-c:a','aac'] : []), '-metadata','title=PRIVATE_ORIGINAL','-metadata','comment=SOURCE_PLATFORM','source.mp4'];

  const result = await runProcess({ executable: tools.ffmpeg, args, cwd: directory, signal: new AbortController().signal, onLine: () => {} });

  assert.equal(result.exitCode, 0, result.stderr);

  const video = await describeFile(directory, 'source.mp4');

  const manifest = { schemaVersion: 1, taskId: id, video, rawMetadataFile: 'media.info.json' };

  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));

  await writeFile(path.join(directory, 'media.info.json'), JSON.stringify({ title: 'Balcony garden', description: 'Grow herbs in a sunny corner.', tags: ['garden'] }));

  const task = { id, createdAt: new Date().toISOString(), asset: manifest };

  return { root, id, directory, manifest, task, video };

}

for (const audio of [true, false]) test(`real bundled FFmpeg transforms ${audio ? 'audio-video' : 'silent video'}, reports stderr progress and strips source metadata`, async t => {

  const f = await fixture(t, audio); const events = [];

  const processor = new MediaProcessor({ dataDirectory: f.root, tools, onProgress: e => events.push(e) });

  const output = await processor.processTask(f.id);

  assert.equal(output.state, 'PROCESSED_READY'); assert.equal(output.width, 316); assert.equal(output.height, 236);

  assert.ok(Math.abs(output.durationSeconds - 2 / 1.02) < 0.15);

  assert.ok(events.some(e => e.phase === 'encoding')); assert.equal(events.at(-1).percent, 100);

  assert.equal((await describeFile(f.directory, 'source.mp4')).sha256, f.video.sha256);

  assert.equal((await describeFile(f.directory, 'processed.mp4')).sha256, output.video.sha256);

  let raw = ''; await runProcess({ executable: tools.ffprobe, args: ['-v','error','-show_format','-show_streams','-of','json','processed.mp4'], cwd: f.directory, signal: new AbortController().signal, onLine: l => { raw += l; } });

  assert.ok(!raw.includes('PRIVATE_ORIGINAL')); assert.ok(!raw.includes('SOURCE_PLATFORM')); assert.ok(!raw.includes('Lavc')); assert.ok(!raw.includes('Lavf'));

  const data = JSON.parse(raw); const sound = data.streams.find(s => s.codec_type === 'audio');

  assert.equal(Boolean(sound), audio); if (sound) assert.equal(sound.sample_rate, '48000');

  await unlink(path.join(f.directory, 'processed.mp4'));

  assert.equal((await processor.readTask(f.id)).video.sha256, output.video.sha256);

  assert.equal((await describeFile(f.directory, 'processed.mp4')).sha256, output.video.sha256);

  const stats = await collectAnalytics(f.root, [f.task]); assert.equal(stats.processedTasks, 1); assert.ok(stats.avgProcessingMs > 0); assert.equal(stats.mediaBytes, f.video.bytes);

});

test('processing failure, timeout and source tampering preserve prior successful output', async t => {

  const f = await fixture(t); const good = new MediaProcessor({ dataDirectory: f.root, tools }); const saved = await good.processTask(f.id);

  const bad = new MediaProcessor({ dataDirectory: f.root, tools }, async () => ({ exitCode: 1, stderr: 'secret' }));

  await assert.rejects(bad.processTask(f.id), { code: 'PROCESS_FAILED' });

  await assert.rejects(good.processTask(f.id, { timeoutMs: 1 }), { code: 'TIMEOUT' });

  assert.equal((await good.readTask(f.id)).video.sha256, saved.video.sha256);

  await writeFile(path.join(f.directory, 'source.mp4'), 'tampered');

  await assert.rejects(good.processTask(f.id), { code: 'SOURCE_CHANGED' });

  assert.equal((await describeFile(f.directory, 'processed.mp4')).sha256, saved.video.sha256);

});

test('processing settings reject dangerous or non-finite inputs and pre-cancellation starts nothing', async t => {

  for (const input of [{speed: 3}, {cropPercent: 100}, {contrast: NaN}, {sharpen: -1}]) assert.throws(() => processingSettings(input), { code: 'INVALID_OPTIONS' });

  const f = await fixture(t); const controller = new AbortController(); controller.abort();

  await assert.rejects(new MediaProcessor({ dataDirectory: f.root, tools }).processTask(f.id, { signal: controller.signal }), { code: 'CANCELLED' });

});

test('multi-platform adapter records actual tokens and failed calls; edits persist with revision guard across restarts', async t => {

  const f = await fixture(t); let calls = 0;

  const llm = async () => {

    calls++; if (calls === 2) return new Response('private detail', { status: 429 });

    return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }, choices: [{ message: { content: '```json\n' + JSON.stringify({ title: '阳台香草角', body: '阳光好的角落，种一点香草。', tags: ['生活'], hook: '小阳台能种什么？' }) + '\n```' }, finish_reason: 'stop' }] });

  };

  const writer = new AIRewriter({ dataDirectory: f.root, baseURL: 'http://localhost:11434/v1' }, llm);

  const result = await writer.rewriteMultiPlatform(f.manifest, ['douyin', 'kuaishou']); assert.equal(result.state, 'partial');

  const doc = result.document; assert.equal(doc.platforms.douyin.usage.totalTokens, 130);

  const edited = await writer.saveCopy(f.id, 'douyin', { ...doc.platforms.douyin, body: '人工编辑，保留原事实。' }, doc.updatedAt);

  await assert.rejects(writer.saveCopy(f.id, 'douyin', doc.platforms.douyin, doc.updatedAt), { code: 'SOURCE_CHANGED' });

  assert.equal((await new AIRewriter({ dataDirectory: f.root }).readTask(f.id)).platforms.douyin.body, '人工编辑，保留原事实。');

  assert.ok(edited.platforms.douyin.editedAt);

  const stats = await collectAnalytics(f.root, [f.task]); assert.equal(stats.aiCalls, 2); assert.equal(stats.tokens, 130); assert.equal(stats.callsWithUsage, 1); assert.equal(stats.aiSuccesses, 1); assert.equal(stats.platforms.douyin, 1);

});


test('invalid LLM output retains reported token usage without inventing a successful rewrite', async t => {
 const f = await fixture(t);
 const writer = new AIRewriter({ dataDirectory: f.root, baseURL: 'http://localhost:11434/v1' }, async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ message: { content: 'not JSON' } }] }));
 const result = await writer.rewriteTask(f.id, ['douyin']); assert.equal(result.state, 'failed');
 const stats = await collectAnalytics(f.root, [f.task]); assert.equal(stats.tokens, 15); assert.equal(stats.aiCalls, 1); assert.equal(stats.aiSuccesses, 0);
});
test('processor prevents overlapping writers and can be cancelled without losing sources', async t => {
 const f = await fixture(t); let started; const running = new Promise(resolve => { started = resolve; });
 const controller = new AbortController();
 const processor = new MediaProcessor({ dataDirectory: f.root, tools }, async request => {
   started(); await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true })); throw new Error('cancelled');
 });
 const pending = processor.processTask(f.id, { signal: controller.signal });
 const rejected = assert.rejects(pending, { code: 'CANCELLED' });
 await running;
 await assert.rejects(new MediaProcessor({ dataDirectory: f.root, tools }).processTask(f.id), { code: 'STORE_LOCKED' });
 controller.abort(); await rejected;
 assert.equal((await describeFile(f.directory, 'source.mp4')).sha256, f.video.sha256);
});
test('new operations survive restart and incomplete/corrupt records are disclosed', async t => {
 const f = await fixture(t); const folder = path.join(f.directory, '.operations'); await mkdir(folder);
 await writeFile(path.join(folder, `${randomUUID()}.json`), JSON.stringify({ schemaVersion:1, taskId:f.id, kind:'rewrite', state:'started' }));
 await writeFile(path.join(folder, `${randomUUID()}.json`), 'corrupted');
 const stats = await collectAnalytics(f.root, [f.task]); assert.equal(stats.aiCalls,1); assert.equal(stats.incomplete,1); assert.equal(stats.unreadableRecords,1); assert.equal(stats.tokens,0); assert.equal(stats.avgProcessingMs,null);
});
test('process runner emits split stderr records and final unterminated line', async () => {
 const lines = [];
 const result = await runProcess({ executable: process.execPath, args: ['-e', "process.stderr.write('out_time_us=10');setTimeout(()=>process.stderr.write('00\\nprogress=end'),10)"], cwd: process.cwd(), signal: new AbortController().signal, onLine:()=>{}, onStderrLine:l=>lines.push(l) });
 assert.equal(result.exitCode,0); assert.deepEqual(lines,['out_time_us=1000','progress=end']);
});
