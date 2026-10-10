// Explicit loopback-only Mock LLM for QA. Never selected by the normal desktop defaults.
import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const folder = path.resolve('artifacts/desktop'); await mkdir(folder, { recursive: true });
const copies = {
 xiaohongshu: { title: '素材总怕丢？｜本地工作台来帮忙', body: '📁 把素材留在本机，整理起来更安心。\n✨ 这份自制测试画面演示视频挂载与处理流程。\n你会如何管理自己的素材库？', tags: ['素材管理','视频创作','本地工作台'] },
 bilibili: { title: '一个测试画面，如何走完本地视频工作流？', body: '用 FFmpeg 自制测试画面，演示本地视频挂载、校验与处理。这不是海外下载的真实视频。你通常如何整理素材？', tags: ['视频制作','工作流'], category: '科技·软件应用' },
 douyin: { title: '一段视频的本地旅程', body: '从挂载到处理，原视频始终保留。自制测试素材，仅演示本地工作流。', hook: '你的视频素材，真的存好了吗？', tags: ['视频创作','素材管理'] },
 kuaishou: { title: '把视频素材收拾好', body: '用一段自制测试画面走一遍：本地挂载、校验和轻量处理。原片不动，心里踏实。', hook: '文件太多不好找？先把视频整理好。', tags: ['素材整理','视频制作'] }
};
let calls = 0;
const server = createServer(async (req, res) => {
 try {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error(); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); const source = JSON.parse(body.messages[1].content);
  const copy = copies[source.targetPlatform]; if (!copy) throw new Error(); calls++;
  console.log(JSON.stringify({ call: calls, platform: source.targetPlatform, model: body.model }));
  await new Promise(resolve => setTimeout(resolve, body.model === 'qa-slow' ? 10000 : 350));
  if (body.model === 'qa-fail') { res.writeHead(429); res.end('Mock rate limit'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '下面是改写结果：\n```json\n' + JSON.stringify(copy) + '\n```' } }], usage: { prompt_tokens: 180, completion_tokens: 80, total_tokens: 260 } }));
 } catch { if (!res.headersSent) res.writeHead(400); res.end('Invalid QA request'); }
});
server.listen(0, '127.0.0.1', async () => {
 const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
 await writeFile(path.join(folder, 'qa-llm.json'), JSON.stringify({ baseURL, pid: process.pid, model: 'qa-local' }, null, 2));
 console.log(`QA Mock LLM listening: ${baseURL}`);
});
