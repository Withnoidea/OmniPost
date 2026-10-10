import type { AssetFile, PortableTools } from '../fetcher/types.js';
export interface ProcessingSettings { speed: number; cropPercent: number; contrast: number; sharpen: number }
export interface ProcessorOptions extends Partial<ProcessingSettings> { timeoutMs?: number; signal?: AbortSignal }
export interface ProcessingProgress { taskId: string; phase: 'probing' | 'encoding' | 'committing' | 'ready'; percent: number }
export interface ProcessedDocument {
  schemaVersion: 1; taskId: string; state: 'PROCESSED_READY'; createdAt: string;
  source: AssetFile; video: AssetFile; exportFile: 'processed.mp4';
  width: number; height: number; durationSeconds: number; durationMs: number; settings: ProcessingSettings;
}
export interface ProcessorConfig { dataDirectory: string; tools: PortableTools; onProgress?: (event: ProcessingProgress) => void }
export type ProcessorErrorCode = 'INVALID_OPTIONS' | 'ASSET_NOT_READY' | 'SOURCE_CHANGED' | 'PROCESS_FAILED' | 'TIMEOUT' | 'CANCELLED' | 'PERSISTENCE_ERROR';
export class ProcessorError extends Error {
  constructor(readonly code: ProcessorErrorCode) {
    const messages: Record<ProcessorErrorCode, string> = { INVALID_OPTIONS: '处理参数超出允许范围。', ASSET_NOT_READY: '请先挂载有效视频。', SOURCE_CHANGED: '原视频与任务记录不一致，请检查素材。', PROCESS_FAILED: 'FFmpeg 处理失败，原始素材与上次产物均已保留。', TIMEOUT: '视频处理超时，可调整参数后重试。', CANCELLED: '视频处理已取消，原素材保留。', PERSISTENCE_ERROR: '处理结果无法安全保存，请检查磁盘权限与空间。' };
    super(messages[code]); this.name = 'ProcessorError';
  }
}
export const DEFAULT_PROCESSING: Readonly<ProcessingSettings> = Object.freeze({ speed: 1.02, cropPercent: 1, contrast: 1.02, sharpen: 0.15 });
export function processingSettings(input: Partial<ProcessingSettings> = {}): ProcessingSettings {
  const settings = { ...DEFAULT_PROCESSING, ...input };
  for (const [key, min, max] of [['speed', 0.5, 2], ['cropPercent', 0, 10], ['contrast', 0.8, 1.2], ['sharpen', 0, 1]] as const) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) throw new ProcessorError('INVALID_OPTIONS');
  }
  return { speed: settings.speed, cropPercent: settings.cropPercent, contrast: settings.contrast, sharpen: settings.sharpen };
}
