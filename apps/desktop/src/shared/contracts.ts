import type { ManualInput } from '../../../../packages/core/src/fetcher/types.js';
import type { PlatformAccount, PublishResult } from '../../../../packages/core/src/publisher/publisher.js';
export type { PlatformAccount, PublishResult };
export interface ManualDraft extends ManualInput { sourceTaskId?: string }
export interface MediaSelection { path: string; name: string }
import type { AIProtocol } from '../../../../packages/core/src/rewriter/types.js';
import type { RewrittenDocument, RewriteTaskResult, RewriteProgress, TargetPlatform, LocalizedCopy } from '../../../../packages/core/src/rewriter/types.js';
import type { ProcessedDocument, ProcessingSettings, ProcessingProgress } from '../../../../packages/core/src/processor/types.js';
import type { AnalyticsSnapshot } from '../../../../packages/core/src/telemetry.js';
export type { RewrittenDocument, RewriteTaskResult, TargetPlatform, LocalizedCopy, ProcessedDocument, ProcessingSettings, AnalyticsSnapshot };
export interface StudioSettings {
  ai: { protocol: AIProtocol; systemPrompt: string; hasCustomHeaders: boolean; baseURL: string; model: string; temperature: number; jsonMode: boolean; hasApiKey: boolean; persisted: boolean };
  processor: ProcessingSettings;
}
export interface SettingsInput { ai: { protocol?: AIProtocol; systemPrompt?: string; headers?: Record<string, string>; baseURL: string; model: string; temperature: number; jsonMode: boolean; apiKey?: string }; processor: ProcessingSettings }
export interface TaskLibrary { rewritten: RewrittenDocument | null; processed: ProcessedDocument | null; active: ('rewrite' | 'process')[] }
export type StudioEvent = { kind: 'rewrite'; progress: RewriteProgress } | { kind: 'process'; progress: ProcessingProgress } | { kind: 'settled'; taskId: string; operation: 'rewrite' | 'process' };
import type { DownloadTask } from '../../../../packages/core/src/fetcher/types.js';
export type { DownloadTask, TaskState, VideoMetadata } from '../../../../packages/core/src/fetcher/types.js';
export interface DesktopFailure { code: string; message: string }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: DesktopFailure };
export interface ProxySettings { enabled: boolean; url: string; persisted: boolean }
export interface ProxyTestResult { ok: boolean; latencyMs: number; error?: string }
export interface Snapshot { tasks: DownloadTask[]; proxy: ProxySettings; version: string; dataDirectory: string }
export interface TaskAssets {
  cover: string | null;
  video: { bytes: number; width: number | null; height: number | null; file: string } | null;
}
export interface DesktopEvent { task: DownloadTask; kind: 'state' | 'metadata' | 'success' | 'failure' }
export interface ElectronAPI {
  createManual(input: ManualDraft): Promise<Reply<DownloadTask>>;
  chooseMedia(kind: 'video' | 'cover'): Promise<Reply<MediaSelection | null>>;
  droppedMedia(file: File): MediaSelection;
  openVerification(taskId: string): Promise<Reply<void>>;
  finishVerification(taskId: string): Promise<Reply<DownloadTask>>;
  accounts(): Promise<Reply<PlatformAccount[]>>;
  connectPlatform(platform: TargetPlatform): Promise<Reply<PlatformAccount>>;
  closePlatform(platform: TargetPlatform): Promise<Reply<void>>;
  publish(taskId: string, platform: TargetPlatform): Promise<Reply<PublishResult>>;
  onAccount(listener: (account: PlatformAccount) => void): () => void;
  fetchModels(settings: SettingsInput['ai']): Promise<Reply<string[]>>;
  studioSettings(): Promise<Reply<StudioSettings>>;
  saveStudioSettings(settings: SettingsInput): Promise<Reply<StudioSettings>>;
  library(taskId: string): Promise<Reply<TaskLibrary>>;
  rewrite(taskId: string, platforms: TargetPlatform[], mode?: 'missing' | 'replace'): Promise<Reply<RewriteTaskResult>>;
  saveCopy(taskId: string, platform: TargetPlatform, copy: LocalizedCopy, revision: string): Promise<Reply<RewrittenDocument>>;
  processMedia(taskId: string): Promise<Reply<ProcessedDocument>>;
  cancelStudio(taskId: string, kind: 'rewrite' | 'process'): Promise<Reply<void>>;
  analytics(): Promise<Reply<AnalyticsSnapshot>>;
  onStudio(listener: (event: StudioEvent) => void): () => void;
  snapshot(): Promise<Reply<Snapshot>>;
  fetchMetadata(url: string): Promise<Reply<DownloadTask>>;
  download(url: string): Promise<Reply<DownloadTask>>;
  selectAndAttach(taskId: string): Promise<Reply<DownloadTask | null>>;
  attachDroppedFile(taskId: string, file: File): Promise<Reply<DownloadTask>>;
  assets(taskId: string): Promise<Reply<TaskAssets>>;
  cancel(taskId: string): Promise<Reply<void>>;
  setProxy(settings: Pick<ProxySettings, 'enabled' | 'url'>): Promise<Reply<ProxySettings>>;
  testProxy(url: string): Promise<Reply<ProxyTestResult>>;
  openAssets(taskId: string): Promise<Reply<void>>;
  copyText(text: string): Promise<Reply<void>>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<Reply<void>>;
  onTask(listener: (event: DesktopEvent) => void): () => void;
}
declare global { interface Window { electronAPI: ElectronAPI } }
