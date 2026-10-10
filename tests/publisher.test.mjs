import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublisherService } from '../dist/packages/core/src/publisher/publisher.js';
import { PLATFORM_ADAPTERS } from '../dist/packages/core/src/publisher/platforms.js';
import { TARGET_PLATFORMS } from '../dist/packages/core/src/rewriter/types.js';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'omni-publisher-'));
  const launches = []; const accounts = []; const contexts = []; const writes = []; const services = [];
  const options = { dataDirectory: root, loginTimeoutMs: 40, pollMs: 1, fieldTimeoutMs: 3, onAccount: account => { accounts.push(account); if (overrides.observerThrows) throw new Error('observer failure'); } };
  const launcher = { async launchPersistentContext(directory, launchOptions) {
    if (overrides.launchError) throw new Error('secret-profile-path');
    launches.push({ directory, launchOptions });
    const platform = path.basename(directory); const adapter = PLATFORM_ADAPTERS[platform];
    const context = new EventEmitter(); let current = 'about:blank'; let closed = false;
    context.setDefaultTimeout = () => {};
    context.cookies = async () => overrides.cookies ?? [{ name: adapter.cookies[0], value: 'private-session', domain: '.' + adapter.hosts[0], expires: -1 }];
    const locator = selector => ({
      first() { return this; },
      async isVisible() { return !overrides.noLogin && adapter.signedIn.includes(selector); },
      async count() { return overrides.missingFields ? 0 : 1; },
      async setInputFiles(file) { writes.push({ platform, kind: 'video', file }); },
      async fill(text) { writes.push({ platform, kind: 'text', selector, text }); },
      async click() { throw new Error('Final submit/click is forbidden'); },
    });
    const page = { url: () => current, isClosed: () => closed, locator, frames() { return [this]; },
      async goto(url) { current = overrides.redirect && url === adapter.upload ? 'https://attacker.test/' : url; if (overrides.closeOnNavigate) await context.close(); },
    };
    context.pages = () => [page]; context.newPage = async () => page;
    context.close = async () => { if (!closed) { closed = true; context.emit('close'); } };
    contexts.push(context); return context;
  } };
  const make = () => { const service = new PublisherService(options, launcher); services.push(service); return service; };
  const service = make(); const video = path.join(root, 'processed.mp4'); await writeFile(video, 'processed fixture');
  t.after(async () => { await Promise.all(services.map(service => service.close())); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  return { root, service, make, launches, accounts, contexts, writes, video };
}
const copy = { title: '平台专属标题', body: '平台专属介绍', tags: ['创作', '视频'], hook: '三秒开场' };
for (const platform of TARGET_PLATFORMS) {
  test(`${platform}: headed persistent profile, verified login closes window and survives restart`, async t => {
    const { service, root, launches, accounts, make } = await fixture(t);
    const connected = await service.connect(platform);
    assert.equal(connected.state, 'connected'); assert.equal(connected.windowOpen, false);
    assert.equal(launches[0].directory, path.join(root, 'profiles', platform)); assert.equal(launches[0].launchOptions.headless, false);
    assert.ok(accounts.some(account => account.state === 'connecting'));
    assert.equal(accounts.at(-1).windowOpen, false);
    const journal = await readFile(path.join(root, 'profiles', 'accounts.json'), 'utf8'); assert.ok(!journal.includes('private-session'));
    const restarted = make(); await restarted.load(); assert.equal(restarted.list().find(account => account.platform === platform).state, 'connected');
  });
  test(`${platform}: processed video and platform copy prefilled, browser retained, never finally published`, async t => {
    const { service, video, writes, contexts } = await fixture(t);
    const result = await service.publish({ platform, videoPath: video, copy });
    assert.equal(result.uploaded, true); assert.equal(result.manualConfirmation, true); assert.equal(result.filled.length, 2);
    assert.ok(writes.some(write => write.kind === 'video' && write.file === video));
    assert.ok(writes.some(write => write.kind === 'text' && write.text.includes('#创作')));
    assert.ok(!contexts[0].pages()[0].isClosed());
    await assert.rejects(service.connect(platform), { code: 'PROFILE_BUSY' });
    await service.closePlatform(platform); assert.equal(contexts[0].pages()[0].isClosed(), true);
  });
}
test('cookies alone, generic profile files or expired login cannot create Connected state', async t => {
  const { service, launches } = await fixture(t, { noLogin: true });
  await assert.rejects(service.connect('douyin'), { code: 'LOGIN_TIMEOUT' });
  assert.equal(service.list().find(account => account.platform === 'douyin').state, 'disconnected'); assert.equal(launches.length, 1);
});
test('expired and unrelated cookies do not authenticate even with signed-in-looking DOM', async t => {
  const { service } = await fixture(t, { cookies: [{ name: 'SESSDATA', value: 'expired', domain: '.bilibili.com', expires: 1 }, { name: 'SESSDATA', value: 'wrong-origin', domain: '.attacker.test', expires: -1 }] });
  await assert.rejects(service.connect('bilibili'), { code: 'LOGIN_TIMEOUT' });
});
test('early window closure cancels login; browser installation errors are sanitized and retryable', async t => {
  const closed = await fixture(t, { closeOnNavigate: true }); await assert.rejects(closed.service.connect('kuaishou'), { code: 'LOGIN_CANCELLED' });
  const missing = await fixture(t, { launchError: true });
  await assert.rejects(missing.service.connect('douyin'), error => error.code === 'BROWSER_UNAVAILABLE' && !error.message.includes('secret-profile'));
});
test('selector drift returns actionable manual fallback, never falsely reports upload/prefill', async t => {
  const { service, video, contexts } = await fixture(t, { missingFields: true });
  const result = await service.publish({ platform: 'douyin', videoPath: video, copy });
  assert.equal(result.uploaded, false); assert.deepEqual(result.filled, []); assert.equal(result.warnings.length, 4);
  assert.equal(contexts[0].pages()[0].isClosed(), false);
});
test('cross-origin redirects never receive local video or copy', async t => {
  const { service, video, writes } = await fixture(t, { redirect: true });
  const result = await service.publish({ platform: 'douyin', videoPath: video, copy });
  assert.equal(result.uploaded, false); assert.deepEqual(writes, []);
});
test('concurrent platform directories are isolated; same-platform login excludes duplicates', async t => {
  const { service, launches } = await fixture(t);
  const first = service.connect('douyin'); await assert.rejects(service.connect('douyin'), { code: 'PROFILE_BUSY' });
  await Promise.all([first, service.connect('bilibili')]); assert.equal(new Set(launches.map(launch => launch.directory)).size, 2);
  assert.throws(() => service.connect('../escape'), { code: 'INVALID_PLATFORM' });
});
test('shutdown closes browser contexts and settles active login without delayed Connected events', async t => {
  const { service, contexts } = await fixture(t, { noLogin: true });
  const pending = service.connect('douyin'); const settled = assert.rejects(pending, error => ['CLOSED', 'LOGIN_CANCELLED'].includes(error.code));
  await service.close(); await settled;
  assert.ok(contexts.every(context => context.pages()[0].isClosed()));
  await assert.rejects(service.connect('douyin'), { code: 'CLOSED' });
});

test('account observer errors cannot interrupt login or browser cleanup', async t => {
  const { service, contexts } = await fixture(t, { observerThrows: true });
  const connected = await service.connect('douyin');
  assert.equal(connected.state, 'connected');
  assert.equal(connected.windowOpen, false);
  assert.equal(contexts[0].pages()[0].isClosed(), true);
});
