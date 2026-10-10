export type Platform = 'youtube' | 'tiktok' | 'local';
export type TaskMode = 'download' | 'metadata';
export type TaskState = 'queued' | 'downloading' | 'finalizing' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'fetching_metadata' | 'attaching' | 'AWAITING_MEDIA' | 'READY';
export type ErrorCode =
  | 'INVALID_URL' | 'INVALID_PROXY' | 'INVALID_OPTIONS' | 'TOOL_NOT_FOUND'
  | 'SPAWN_FAILED' | 'DOWNLOAD_FAILED' | 'NETWORK_ERROR' | 'AUTH_REQUIRED'
  | 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED'
  | 'INVALID_OUTPUT' | 'PERSISTENCE_ERROR' | 'INTERRUPTED' | 'SCHEDULER_CLOSED' | 'STORE_LOCKED' | 'INVALID_MEDIA' | 'INVALID_STATE';

export interface Failure { code: ErrorCode; message: string; retryable: boolean }
export interface DownloadProgress {
  phase: 'download' | 'postprocess';
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}
export interface VideoMetadata {
  id: string;
  platform: Platform;
  title: string;
  description: string;
  uploader: string | null;
  channel: string | null;
  durationSeconds: number | null;
  language: string | null;
  uploadDate: string | null;
  tags: string[];
  categories: string[];
  subtitleLanguages: string[];
  automaticCaptionLanguages: string[];
}
export interface AssetFile { file: string; bytes: number; sha256: string }
export interface MetadataManifest {
  schemaVersion: 1;
  taskId: string;
  sourceUrl: string;
  createdAt: string;
  thumbnail: AssetFile;
  metadataFile: 'metadata.json';
  rawMetadataFile: 'media.info.json';
  metadata: VideoMetadata;
}
export interface AssetManifest extends MetadataManifest { video: AssetFile }
export interface DownloadTask {
  schemaVersion: 1;
  id: string;
  sourceUrl: string;
  platform: Platform;
  /** Absent in pre-metadata journals: treat as download. */
  mode?: TaskMode;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  progress?: DownloadProgress;
  asset?: AssetManifest;
  metadataAsset?: MetadataManifest;
  error?: Failure;
}
export interface DownloadRequest {
  url: string;
  /** HTTP(S)/SOCKS5 URL; held in memory only. Empty or omitted explicitly disables ambient proxies. */
  proxy?: string;
  /** Total fetch + finalization deadline for the selected mode, starts when dequeued. */
  timeoutMs?: number;
}
export type MetadataOptions = Omit<DownloadRequest, 'url'>;
export type DownloadEvent =
  | { type: 'state'; task: DownloadTask }
  | { type: 'progress'; taskId: string; progress: DownloadProgress }
  | { type: 'metadata'; task: DownloadTask; metadata: MetadataManifest }
  | { type: 'success'; task: DownloadTask; asset: AssetManifest }
  | { type: 'failure'; task: DownloadTask; error: Failure };
export interface DownloadCallbacks {
  onEvent?: (event: DownloadEvent) => void;
  onProgress?: (taskId: string, progress: DownloadProgress) => void;
  onMetadata?: (task: DownloadTask, metadata: MetadataManifest) => void;
  onSuccess?: (task: DownloadTask, asset: AssetManifest) => void;
  onError?: (task: DownloadTask, error: Failure) => void;
}
export interface PortableTools {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
  /** Explicit portable JS runtime for contemporary YouTube extraction. Never resolved via PATH. */
  node: string;
}
export interface SchedulerOptions extends DownloadCallbacks {
  dataDirectory: string;
  tools: PortableTools;
  concurrency?: number;
  timeoutMs?: number;
  /** Independent metadata deadline; default 15 seconds, no request retries. */
  metadataTimeoutMs?: number;
  socketTimeoutSeconds?: number;
  retries?: number;
}

/** A manual revision creates a new immutable asset; existing tasks are never overwritten. */
export interface ManualInput {
  title: string; description: string; tags: string[]; author: string;
  sourceUrl?: string; videoPath?: string; coverPath?: string;
}
