// Run only against the explicit QA desktop (CDP :9223), never the user's main window.
// CDP's native file payload is needed because a JS-created File has no filesystem path.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const fixture = JSON.parse(await readFile('artifacts/desktop/qa-fixture.json', 'utf8'));
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(t => t.type === 'page');
assert.ok(target);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
    if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
  }
};
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout')); }, 15000);
    pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params }));
  });
}
try {
  const { result: snapshot } = await rpc('Runtime.evaluate', { expression: 'window.electronAPI.snapshot()', awaitPromise: true, returnByValue: true });
  assert.equal(snapshot.value.value.dataDirectory, fixture.dataDirectory, 'Refuse to mutate non-QA library');
  for (const taskId of fixture.taskIds) {
    const task = snapshot.value.value.tasks.find(t => t.id === taskId);
    if (task?.state === 'READY') continue;
    await rpc('Runtime.evaluate', { expression: `document.querySelectorAll('.queue-row').forEach(e => { if(e.textContent.includes(${JSON.stringify(taskId.slice(0,8))})) e.click(); });` });
    await new Promise(resolve => setTimeout(resolve, 250));
    const { result } = await rpc('Runtime.evaluate', { expression: `(() => { const e = document.querySelector('.dropzone'); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`, returnByValue: true });
    const data = { items: [], files: [fixture.video], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await rpc('Input.dispatchDragEvent', { type, ...result.value, data });
    await new Promise(resolve => setTimeout(resolve, 1800));
  }
  const deadline = Date.now() + 15000;
  let tasks;
  while (Date.now() < deadline) {
    const { result: state } = await rpc('Runtime.evaluate', { expression: 'window.electronAPI.snapshot()', awaitPromise: true, returnByValue: true });
    tasks = state.value.value.tasks.filter(task => fixture.taskIds.includes(task.id));
    if (tasks.every(t => t.state === 'READY')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(tasks.every(t => t.state === 'READY'), 'Native file drag must reach READY');
  const source = await readFile(fixture.video); const sha = createHash('sha256').update(source).digest('hex');
  for (const task of tasks) {
    assert.equal(task.asset.video.sha256, sha);
    assert.deepEqual(task.asset.metadata, task.metadataAsset.metadata);
    assert.ok((await stat(path.join(fixture.dataDirectory, 'assets', task.id, 'media.info.json'))).size > 0);
    assert.equal((await stat(path.join(fixture.dataDirectory, 'assets', task.id, task.asset.video.file))).size, source.length);
  }
  console.log('PASS: native file drag, 2 READY tasks, SHA-256 matches, original + metadata preserved');
} finally { socket.close(); }
