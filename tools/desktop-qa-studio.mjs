import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const fixture = JSON.parse(await readFile('artifacts/desktop/qa-fixture.json', 'utf8'));
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const target = targets.find(t => t.type === 'page'); assert.ok(target);
const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let id=0; const pending = new Map();
socket.onmessage = event => { const value=JSON.parse(event.data); const item=pending.get(value.id); if(!item)return;pending.delete(value.id);clearTimeout(item.timer); if(value.error)item.reject(new Error(JSON.stringify(value.error)));else item.resolve(value.result); };
async function evaluate(expression) {
 const result=await new Promise((resolve,reject)=>{ const key=++id;const timer=setTimeout(()=>reject(new Error('CDP deadline')),25000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})); });
 if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;
}
const unwrap = r=>{assert.equal(r.ok,true,JSON.stringify(r.error));return r.value;};
const passed=[];
try {
 const snapshot=unwrap(await evaluate('window.electronAPI.snapshot()'));
 assert.equal(snapshot.dataDirectory,fixture.dataDirectory,'Refuse non-QA library');
 const task=snapshot.tasks.find(t=>t.id===fixture.taskIds[1]); assert.equal(task.state,'READY');
 const library=unwrap(await evaluate(`window.electronAPI.library(${JSON.stringify(task.id)})`));
 assert.equal(Object.keys(library.rewritten.platforms).length,4); assert.equal(library.processed.state,'PROCESSED_READY');passed.push('four platform outputs and real processing restored');
 const replies=await evaluate(`Promise.all(Array.from({length:10},()=>window.electronAPI.library(${JSON.stringify(task.id)})))`); replies.forEach(unwrap);passed.push('10 concurrent library IPC reads coalesced, no STORE_LOCKED');
 const source=await readFile(fixture.video); const hash=createHash('sha256').update(source).digest('hex');assert.equal(task.asset.video.sha256,hash);
 const directory=path.join(fixture.dataDirectory,'assets',task.id);const output=await readFile(path.join(directory,'processed.mp4'));assert.equal(createHash('sha256').update(output).digest('hex'),library.processed.video.sha256);passed.push('original SHA256 retained, processed.mp4 matches committed version');
 const settings=unwrap(await evaluate('window.electronAPI.studioSettings()'));assert.equal(Object.hasOwn(settings.ai,'apiKey'),false);assert.equal(settings.ai.hasApiKey,true);
 const settingsDisk=await readFile(path.join(fixture.dataDirectory,'.desktop','studio-settings.json'),'utf8');assert.ok(!settingsDisk.includes('qa-offline-secret'));assert.ok(JSON.parse(settingsDisk).encryptedKey);passed.push('API key encrypted at rest and never returned to renderer');
 const before=unwrap(await evaluate('window.electronAPI.analytics()'));
 for(const [model,expected] of [['qa-fail','RATE_LIMITED'],['qa-slow','CANCELLED']]) {
  unwrap(await evaluate(`window.electronAPI.saveStudioSettings(${JSON.stringify({...settings,ai:{...settings.ai,model}})})`));
  const expression = model==='qa-slow' ? `(async()=>{const pending=window.electronAPI.rewrite(${JSON.stringify(task.id)},['douyin']);await new Promise(r=>setTimeout(r,150));await window.electronAPI.cancelStudio(${JSON.stringify(task.id)},'rewrite');return pending;})()` : `window.electronAPI.rewrite(${JSON.stringify(task.id)},['douyin'])`;
  const result=unwrap(await evaluate(expression));assert.equal(result.errors.douyin.code,expected);
 }
 unwrap(await evaluate(`window.electronAPI.saveStudioSettings(${JSON.stringify(settings)})`));
 const after=unwrap(await evaluate('window.electronAPI.analytics()'));assert.equal(after.aiCalls,before.aiCalls+2);assert.equal(after.aiSuccesses,before.aiSuccesses);assert.equal(after.tokens,before.tokens);assert.equal(after.incomplete,0);
 const retained=unwrap(await evaluate(`window.electronAPI.library(${JSON.stringify(task.id)})`));assert.deepEqual(retained.rewritten,library.rewritten);passed.push('429 and cancellation preserve copies, count attempts, never fabricate tokens');
 const invalid=await evaluate(`window.electronAPI.library('../escape')`);assert.equal(invalid.ok,false);passed.push('IPC rejects traversal');
 const result={testedAt:new Date().toISOString(),dataDirectory:fixture.dataDirectory,taskId:task.id,passed,analytics:after};await writeFile('artifacts/desktop/studio-e2e.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {socket.close();}
