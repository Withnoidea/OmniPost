import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../dist/packages/core/src/fetcher/process.js';
import { FetcherError } from '../dist/packages/core/src/fetcher/errors.js';
const fixture = fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));

test('real child process handles split lines, final unterminated line and stderr', async () => {
  const lines = [];
  const result = await runProcess({ executable: process.execPath, args: [fixture, 'lines'], cwd, signal: new AbortController().signal, onLine: (line) => lines.push(line) });
  assert.equal(result.exitCode, 0); assert.equal(result.stderr, 'diagnostic');
  assert.deepEqual(lines, ['first', 'second', 'last']);
});
test('runner strips ambient proxies and passes shell metacharacters literally', async () => {
  const previous = process.env.HTTPS_PROXY; const secret = process.env.OMNIPOST_PROXY;
  process.env.HTTPS_PROXY = 'http://u:secret@host'; process.env.OMNIPOST_PROXY = 'credential';
  try {
    const lines = [];
    const literal = 'http://u:p&whoami@host:8080';
    await runProcess({ executable: process.execPath, args: [fixture, 'env', literal], cwd, signal: new AbortController().signal, onLine: (line) => lines.push(line) });
    assert.deepEqual(JSON.parse(lines[0]), { args: [literal] });
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous;
    if (secret === undefined) delete process.env.OMNIPOST_PROXY; else process.env.OMNIPOST_PROXY = secret;
  }
});
test('runner cancellation kills the actual parent and grandchild process tree', { timeout: 15000 }, async () => {
  const controller = new AbortController();
  let grandchild;
  const run = runProcess({ executable: process.execPath, args: [fixture, 'tree'], cwd, signal: controller.signal, onLine: (line) => {
    if (line.startsWith('grandchild:')) { grandchild = Number(line.slice(11)); controller.abort(new FetcherError('TIMEOUT')); }
  } });
  await assert.rejects(run, { code: 'TIMEOUT' });
  assert.ok(grandchild > 0);
  let alive = true;
  for (let i = 0; i < 30; i++) {
    try { process.kill(grandchild, 0); } catch { alive = false; break; }
    await delay(50);
  }
  assert.equal(alive, false, 'grandchild must not outlive task cancellation');
});
test('missing executable and pre-aborted signal report typed errors', async () => {
  await assert.rejects(runProcess({ executable: 'Z:\\omnipost-no-such-executable', args: [], cwd, signal: new AbortController().signal, onLine() {} }), { code: 'SPAWN_FAILED' });
  const controller = new AbortController(); controller.abort(new FetcherError('CANCELLED'));
  await assert.rejects(runProcess({ executable: process.execPath, args: [], cwd, signal: controller.signal, onLine() {} }), { code: 'CANCELLED' });
});
