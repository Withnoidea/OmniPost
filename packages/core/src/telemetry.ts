import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, isRecord, TASK_ID } from './fetcher/store.js';
import type { DownloadTask } from './fetcher/types.js';
import type { TargetPlatform, TokenUsage } from './rewriter/types.js';
import { loadPublications, calculateCreatorPulse, type CreatorPulseMetrics, type PublicationRecord } from './publisher/publications.js';
export type { CreatorPulseMetrics, PublicationRecord };
export interface OperationRecord {
  schemaVersion: 1; id: string; taskId: string; kind: 'rewrite' | 'process';
  startedAt: string; finishedAt?: string; state: 'started' | 'succeeded' | 'failed';
  platform?: TargetPlatform; usage?: TokenUsage; durationMs?: number;
}
/** One atomic document per attempt. A crash leaves an honest incomplete attempt, not a fabricated success. */
export async function writeOperation(directory: string, record: OperationRecord): Promise<void> {
  const folder = path.join(directory, '.operations');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== path.join(await realpath(directory), '.operations')) throw new Error('Unsafe operation directory');
  await atomicJson(path.join(folder, `${record.id}.json`), record);
}
export function newOperation(taskId: string, kind: OperationRecord['kind'], platform?: TargetPlatform): OperationRecord {
  return { schemaVersion: 1, id: randomUUID(), taskId, kind, state: 'started', startedAt: new Date().toISOString(), ...(platform ? { platform } : {}) };
}
export interface AnalyticsSnapshot {
  tasks: number; readyTasks: number; processedTasks: number; mediaBytes: number;
  aiCalls: number; aiSuccesses: number; tokens: number; callsWithUsage: number;
  avgProcessingMs: number | null; incomplete: number; unreadableRecords: number;
  trend: { date: string; tasks: number }[];
  platforms: Record<TargetPlatform, number>;
  creator?: CreatorPulseMetrics | undefined;
}
export async function collectAnalytics(root: string, tasks: DownloadTask[], now = new Date()): Promise<AnalyticsSnapshot> {
  const result: AnalyticsSnapshot = { tasks: tasks.length, readyTasks: tasks.filter(t => t.asset).length, processedTasks: 0,
    mediaBytes: tasks.reduce((n, t) => n + (t.asset?.video.bytes ?? 0), 0), aiCalls: 0, aiSuccesses: 0, tokens: 0, callsWithUsage: 0,
    avgProcessingMs: null, incomplete: 0, unreadableRecords: 0, trend: [], platforms: { xiaohongshu: 0, bilibili: 0, douyin: 0, kuaishou: 0 } };
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(now); date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    result.trend.push({ date: key, tasks: tasks.filter(t => t.createdAt.slice(0, 10) === key).length });
  }
  let latency = 0, processes = 0;
  const processed = new Set<string>();
  for (const task of tasks) {
    if (!TASK_ID.test(task.id)) continue;
    const folder = path.join(root, 'assets', task.id, '.operations');
    let files: string[];
    try {
      if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== path.join(await realpath(root), 'assets', task.id, '.operations')) throw new Error();
      files = await readdir(folder);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.unreadableRecords++; continue; }
    for (const file of files) {
      if (!TASK_ID.test(file.replace(/\.json$/, '')) || !file.endsWith('.json')) continue;
      try {
        const full = path.join(folder, file); const stat = await lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error();
        const r: unknown = JSON.parse(await readFile(full, 'utf8'));
        if (!isRecord(r) || r.schemaVersion !== 1 || r.taskId !== task.id || !['started','succeeded','failed'].includes(String(r.state)) || !['rewrite','process'].includes(String(r.kind))) throw new Error();
        if (r.state === 'started') result.incomplete++;
        if (r.kind === 'rewrite') {
          result.aiCalls++;
          if (isRecord(r.usage) && typeof r.usage.totalTokens === 'number' && Number.isSafeInteger(r.usage.totalTokens) && r.usage.totalTokens >= 0) { result.tokens += r.usage.totalTokens; result.callsWithUsage++; }
          if (r.state === 'succeeded') {
            result.aiSuccesses++;
            if (typeof r.platform === 'string' && Object.hasOwn(result.platforms, r.platform)) result.platforms[r.platform as TargetPlatform]++;
          }
        } else if (r.state === 'succeeded' && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0) {
          latency += r.durationMs; processes++; processed.add(task.id);
        }
      } catch { result.unreadableRecords++; }
    }
  }
  result.processedTasks = processed.size; result.avgProcessingMs = processes ? latency / processes : null;
  const publications = await loadPublications(root);
  result.creator = calculateCreatorPulse(publications);
  return result;
}
