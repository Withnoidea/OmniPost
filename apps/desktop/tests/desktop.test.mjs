import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { assetPath, imageMime, taskId, text } from '../src/main/security.ts';
import { bytes, duration, isBusy, isReady, proxyLabel, upsert } from '../src/renderer/model.ts';

test('IPC validates UUID and rejects traversal', () => {
  assert.equal(taskId('12345678-1234-1234-1234-123456789abc'), '12345678-1234-1234-1234-123456789abc');
  for (const value of ['../secret', '', null, {}, '1234']) assert.throws(() => taskId(value));
});
test('IPC bounded strings reject control / wrong types', () => {
  assert.equal(text(' hello '), 'hello');
  for (const value of ['', 'x'.repeat(2049), 'a\0b', {}, 3]) assert.throws(() => text(value));
});
test('raster sniffing accepts only JPG PNG WEBP, never SVG or HTML', () => {
  assert.equal(imageMime(Buffer.from([255,216,255,224])), 'image/jpeg');
  assert.equal(imageMime(Buffer.from([137,80,78,71,13,10,26,10])), 'image/png');
  assert.equal(imageMime(Buffer.from('RIFFabcdWEBP')), 'image/webp');
  for (const value of ['<svg></svg>', '<html>', 'GIF89a', '']) assert.equal(imageMime(Buffer.from(value)), null);
});
test('asset IPC cannot escape the task directory, reference ADS or directories', async () => {
  const base = path.resolve('artifacts/desktop/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'assets-'));
  await writeFile(path.join(root, 'cover.jpg'), 'safe');
  await mkdir(path.join(root, 'sub'));
  assert.equal(await assetPath(root, 'cover.jpg'), await realpath(path.join(root, 'cover.jpg')));
  for (const file of ['../outside', '..\\outside', 'C:\\secret', 'cover.jpg:stream', 'sub', '']) await assert.rejects(assetPath(root, file));
});
test('proxy badge never includes credentials', () => {
  assert.equal(proxyLabel(true, 'socks5://alice:secret@127.0.0.1:7890'), '127.0.0.1:7890');
  assert.equal(proxyLabel(false, 'http://alice:secret@host'), '直连模式');
});
test('task states distinguish waiting, copying and ready', () => {
  assert.equal(isBusy({ state: 'AWAITING_MEDIA' }), false);
  assert.equal(isBusy({ state: 'attaching' }), true);
  assert.equal(isBusy(), false);
  assert.equal(isReady({ state: 'READY' }), true);
  assert.equal(isReady({ state: 'completed' }), true);
  assert.equal(isReady({ state: 'failed' }), false);
});
test('late initial snapshot cannot overwrite newer IPC event', () => {
  const newer = { id: 'a', state: 'READY', createdAt: '2026-01-01', updatedAt: '2026-01-03' };
  const older = { ...newer, state: 'AWAITING_MEDIA', updatedAt: '2026-01-02' };
  assert.deepEqual(upsert([newer], [older]), [newer]);
  assert.deepEqual(upsert([older], [newer]), [newer]);
});
test('queue sorts newest first and avoids duplicate tasks', () => {
  const a = { id: 'a', createdAt: '2026-01-01', updatedAt: '2026-01-03' };
  const b = { ...a, id: 'b', createdAt: '2026-01-02' };
  assert.deepEqual(upsert([a], [a, b]).map(t => t.id), ['b', 'a']);
});
test('duration formats long videos and unknown metadata', () => {
  assert.equal(duration(65), '1:05'); assert.equal(duration(3601), '1:00:01'); assert.equal(duration(null), '时长未知');
});
test('file size uses actual binary units', () => {
  assert.equal(bytes(1024 ** 2), '1.0 MB'); assert.equal(bytes(1024 ** 3), '1.00 GB');
});
