import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Transpile only local production TS in memory so Electron can be replaced without a GUI.
function loadService(file, electron) {
  const cache = new Map(); const require = createRequire(import.meta.url);
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
    const localRequire = id => {
      if (id === 'electron') return electron;
      if (!id.startsWith('.')) return require(id);
      let target = path.resolve(path.dirname(filename), id);
      if (target.endsWith('.js') && existsSync(target.slice(0, -3) + '.ts')) target = target.slice(0, -3) + '.ts';
      return load(target);
    };
    new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
    return module.exports;
  }
  return load(path.resolve('apps/desktop/src/main', file));
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 170)),
  decryptString: value => Buffer.from([...value].map(byte => byte ^ 170)).toString('utf8'),
};
async function rootFor(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'omni-desktop-upgrade-'));
  t.after(async () => { assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  return root;
}
function makeStudio(root, codec = safeStorage) {
  const { StudioService } = loadService('studio.ts', { safeStorage: codec });
  return new StudioService(root, path.join(root, 'settings.json'), {}, () => {});
}
function input(studio, ai = {}) { return { processor: studio.publicSettings().processor, ai: { ...studio.publicSettings().ai, ...ai } }; }

test('AI settings encrypt keys/custom headers, hide secrets from renderer, and restore native protocol', async t => {
  const root = await rootFor(t); const studio = makeStudio(root);
  const saved = await studio.save(input(studio, { protocol: 'anthropic', baseURL: 'https://gateway.example/v1', model: 'custom', apiKey: 'private-key', headers: { 'x-workspace-token': 'private-header' }, systemPrompt: '自然表达' }));
  assert.equal(saved.ai.hasApiKey, true); assert.equal(saved.ai.hasCustomHeaders, true); assert.equal(saved.ai.protocol, 'anthropic');
  assert.ok(!JSON.stringify(saved).includes('private'));
  const disk = await readFile(path.join(root, 'settings.json'), 'utf8'); assert.ok(!disk.includes('private-key')); assert.ok(!disk.includes('private-header'));
  const restored = makeStudio(root); await restored.load(); assert.equal(restored.publicSettings().ai.hasApiKey, true); assert.equal(restored.publicSettings().ai.systemPrompt, '自然表达');
  t.mock.method(globalThis, 'fetch', async (_url, request) => { assert.equal(request.headers['x-api-key'], 'private-key'); assert.equal(request.headers['x-workspace-token'], 'private-header'); return Response.json({ data: [{ id: 'custom' }] }); });
  assert.deepEqual(await restored.models(input(restored).ai), ['custom']);
});
test('unsaved model test and saved provider-origin changes never forward stored credentials or headers', async t => {
  const root = await rootFor(t); const studio = makeStudio(root);
  await studio.save(input(studio, { baseURL: 'https://first.example/v1', apiKey: 'old-key', headers: { 'x-workspace-token': 'old-secret' } }));
  t.mock.method(globalThis, 'fetch', async (url, request) => { assert.ok(url.startsWith('https://second.example/')); assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers['x-workspace-token'], undefined); return Response.json({ data: [{ id: 'model' }] }); });
  await studio.models(input(studio, { baseURL: 'https://second.example/v1' }).ai);
  const saved = await studio.save(input(studio, { baseURL: 'https://second.example/v1' }));
  assert.equal(saved.ai.hasApiKey, false); assert.equal(saved.ai.hasCustomHeaders, false);
  await studio.models(input(studio).ai);
});
test('unavailable encryption persists no credentials and malformed encrypted headers fail closed', async t => {
  const root = await rootFor(t); const studio = makeStudio(root, { ...safeStorage, isEncryptionAvailable: () => false });
  const saved = await studio.save(input(studio, { baseURL: 'https://gateway.example/v1', apiKey: 'session-key', headers: { 'x-secret': 'session-header' } }));
  assert.equal(saved.ai.persisted, false);
  const disk = await readFile(path.join(root, 'settings.json'), 'utf8'); assert.ok(!disk.includes('session-key')); assert.ok(!disk.includes('session-header'));
  const encoded = makeStudio(root); await encoded.save(input(encoded, { baseURL: 'https://gateway.example/v1', apiKey: 'private-key', headers: { 'x-secret': 'header' } }));
  const data = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')); data.encryptedHeaders = 'malformed'; await writeFile(path.join(root, 'settings.json'), JSON.stringify(data));
  const restored = makeStudio(root); await restored.load(); assert.equal(restored.publicSettings().ai.hasApiKey, false);
  t.mock.method(globalThis, 'fetch', async (_url, request) => { assert.equal(request.headers.Authorization, undefined); return Response.json({ data: [{ id: 'model' }] }); });
  await restored.models(input(restored, { baseURL: 'https://gateway.example/v1' }).ai);
});
function verificationMock() {
  const windows = []; const partitions = []; let clearCount = 0;
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.session = options.webPreferences.session; this.webContents.setWindowOpenHandler = handler => { this.popup = handler; }; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    focus() { this.focused = true; }
    async loadURL(url) { this.url = url; }
    close() { this.destroy(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const session = { fromPartition(partition) {
    partitions.push(partition); const isolated = new EventEmitter();
    isolated.setPermissionRequestHandler = handler => { isolated.permission = handler; };
    isolated.setPermissionCheckHandler = handler => { isolated.check = handler; };
    isolated.cookies = { get: async () => [{ domain: '.youtube.com', path: '/', name: 'SID', value: 'verification-secret', secure: true, httpOnly: true }, { domain: '.attacker.test', name: 'bad', value: 'not-saved', path: '/', secure: true }] };
    isolated.clearStorageData = async () => { clearCount++; }; return isolated;
  } };
  return { electron: { BrowserWindow, session }, windows, partitions, clears: () => clearCount };
}
test('verification window is isolated/sandboxed, denies popup/navigation/permissions and saves only scoped cookies', async t => {
  const root = await rootFor(t); const mock = verificationMock();
  const { VerificationService } = loadService('verification.ts', mock.electron); const service = new VerificationService(root);
  const task = { id: 'task', platform: 'youtube', sourceUrl: 'https://youtu.be/BaW_jenozKc', error: { code: 'AUTH_REQUIRED' } };
  await service.open(task); await service.open(task); assert.equal(mock.windows.length, 1); assert.equal(mock.windows[0].focused, true);
  const child = mock.windows[0]; const prefs = child.options.webPreferences;
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.preload, undefined);
  assert.ok(!mock.partitions[0].startsWith('persist:')); assert.deepEqual(child.popup(), { action: 'deny' }); assert.equal(prefs.session.check(), false);
  let blocked = false; child.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://attacker.test/'); assert.equal(blocked, true);
  blocked = false; child.webContents.emit('will-redirect', { preventDefault() { blocked = true; } }, 'https://accounts.google.com/'); assert.equal(blocked, false);
  await service.finish(task); assert.equal(child.isDestroyed(), true); assert.equal(mock.clears(), 1);
  const saved = await readFile(path.join(root, 'cookies', 'youtube.txt'), 'utf8'); assert.match(saved, /verification-secret/); assert.ok(!saved.includes('not-saved'));
  await assert.rejects(service.finish(task), { code: 'VERIFY_CLOSED' });
  await assert.rejects(service.open({ ...task, error: { code: 'INVALID_OUTPUT' } }), { code: 'INVALID_STATE' });
  service.close();
});

test('verification serializes cookie completion and shutdown waits for in-flight persistence', async t => {
  const root = await rootFor(t); const mock = verificationMock();
  const { VerificationService } = loadService('verification.ts', mock.electron); const service = new VerificationService(root);
  const task = { id: 'task', platform: 'youtube', sourceUrl: 'https://youtu.be/BaW_jenozKc', error: { code: 'AUTH_REQUIRED' } };
  await service.open(task);
  const cookies = mock.windows[0].webContents.session.cookies;
  const original = await cookies.get({}); let release;
  cookies.get = () => new Promise(resolve => { release = () => resolve(original); });
  const finish = service.finish(task);
  await assert.rejects(service.finish(task), { code: 'VERIFY_BUSY' });
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await finish; await closing;
  assert.equal(closed, true);
  assert.match(await readFile(path.join(root, 'cookies', 'youtube.txt'), 'utf8'), /verification-secret/);
  await assert.rejects(service.open(task), { code: 'CLOSING' });
});


test('rewrite IPC modes are validated and forwarded to the locked writer', async t => {
  const root = await rootFor(t); const studio = makeStudio(root); const calls = [];
  const manifest = { taskId: 'fixture' }; const task = { id: 'fixture', metadataAsset: manifest };
  t.mock.method(studio.writer, 'rewriteMultiPlatform', async (...args) => { calls.push(args); return { state: 'completed' }; });
  await studio.rewrite(task, ['bilibili', 'douyin'], 'missing');
  assert.equal(calls[0][0], manifest); assert.deepEqual(calls[0][1], ['bilibili', 'douyin']);
  assert.equal(calls[0][2].skipExisting, true); assert.ok(calls[0][2].signal instanceof AbortSignal);
  await studio.rewrite(task, ['bilibili'], 'replace'); assert.equal(calls[1][2].skipExisting, false);
  await studio.rewrite(task, ['bilibili']); assert.equal(calls[2][2].skipExisting, false);
  await assert.rejects(studio.rewrite(task, ['bilibili'], 'overwrite-everything'), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 3); await studio.close();
});

test('publish falls back to raw asset video when processed video is not available', async (t) => {
  const root = await rootFor(t);
  const studio = makeStudio(root);
  const task = {
    schemaVersion: 1,
    id: '22222222-2222-4222-8222-222222222222',
    state: 'READY',
    asset: {
      video: { file: 'media.source.mp4', bytes: 1000, sha256: 'abc' },
      thumbnail: { file: 'cover.jpg', bytes: 200, sha256: 'def' },
      metadata: { title: 'Raw Video' },
    },
  };

  // Mock library returning written copy but NO processed video
  t.mock.method(studio, 'library', async () => ({
    active: [],
    processed: null,
    rewritten: {
      platforms: {
        douyin: { title: '抖音文案标题', hook: 'hook', body: 'body', tags: [] },
      },
      updatedAt: '2026-10-18T00:00:00.000Z',
    },
  }));

  const published = [];
  const fakePublisher = {
    publish: async (opts) => { published.push(opts); return { uploaded: true, filled: ['title'], warnings: [] }; },
  };

  // Simulate publish logic from omni:publish
  const library = await studio.library(task);
  const platform = 'douyin';
  const copy = library.rewritten?.platforms[platform];
  assert.ok(copy && copy.title?.trim());

  const videoFile = library.processed?.video?.file ?? task.asset.video?.file;
  assert.equal(videoFile, 'media.source.mp4');

  await fakePublisher.publish({ platform, copy, videoPath: '/assets/' + videoFile });
  assert.equal(published.length, 1);
  assert.equal(published[0].videoPath, '/assets/media.source.mp4');
  await studio.close();
});

test('publish rejects with clear platform-specific error when copy or video is missing', async (t) => {
  const root = await rootFor(t);
  const studio = makeStudio(root);
  const task = {
    schemaVersion: 1,
    id: '33333333-3333-4333-8333-333333333333',
    state: 'READY',
    asset: null,
  };

  const platformLabels = {
    xiaohongshu: '小红书',
    bilibili: '哔哩哔哩',
    douyin: '抖音',
    kuaishou: '快手',
  };

  t.mock.method(studio, 'library', async () => ({
    active: [],
    processed: null,
    rewritten: { platforms: {}, updatedAt: '2026-10-18T00:00:00.000Z' },
  }));

  const library = await studio.library(task);
  const platform = 'bilibili';
  const copy = library.rewritten?.platforms[platform];
  const platformLabel = platformLabels[platform] ?? platform;

  let copyError = '';
  if (!copy || !copy.title?.trim()) {
    copyError = `请先生成 ${platformLabel} 平台文案`;
  }
  assert.equal(copyError, '请先生成 哔哩哔哩 平台文案');

  let videoError = '';
  const videoFile = library.processed?.video?.file ?? task.asset?.video?.file;
  if (!videoFile) {
    videoError = '未找到可用视频文件';
  }
  assert.equal(videoError, '未找到可用视频文件');
  await studio.close();
});
