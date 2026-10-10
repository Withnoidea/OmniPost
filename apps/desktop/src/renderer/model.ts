import type { DownloadTask, TaskState } from '../shared/contracts.js';
export const stateLabels: Record<TaskState, string> = {
  queued: '排队中', fetching_metadata: '正在解析', downloading: '正在下载', finalizing: '正在保存',
  AWAITING_MEDIA: '等待视频挂载', attaching: '正在校验并挂载', READY: '媒体已就绪', completed: '媒体已就绪',
  failed: '解析失败', cancelled: '已取消', interrupted: '任务已中断'
};
export const isBusy = (task?: DownloadTask): boolean => Boolean(task && ['queued', 'fetching_metadata', 'downloading', 'finalizing', 'attaching'].includes(task.state));
export const isReady = (task?: DownloadTask): boolean => task?.state === 'READY' || task?.state === 'completed';
export const metadataOf = (task?: DownloadTask) => task?.asset?.metadata ?? task?.metadataAsset?.metadata;
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '时长未知';
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
export function bytes(size: number): string {
  return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
}
export function proxyLabel(enabled: boolean, url: string): string {
  if (!enabled) return '直连模式';
  try { return new URL(url).host; } catch { return '代理已配置'; }
}
export function upsert(tasks: DownloadTask[], incoming: DownloadTask[]): DownloadTask[] {
  const map = new Map(tasks.map(task => [task.id, task]));
  for (const task of incoming) {
    const old = map.get(task.id);
    if (!old || old.updatedAt <= task.updatedAt) map.set(task.id, task);
  }
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
