export const TARGET_PLATFORMS = Object.freeze(['xiaohongshu', 'bilibili', 'douyin', 'kuaishou'] as const);
export type TargetPlatform = typeof TARGET_PLATFORMS[number];
export interface SubtitleSnippet { text?: string; data?: string; url?: string; ext?: string }
/** A text-only subset of yt-dlp info JSON. Subtitle URLs are never fetched or sent to the LLM. */
export interface RewriteInput {
  title: string;
  description?: string;
  tags?: string[];
  language?: string | null;
  transcript?: string;
  subtitles?: Record<string, SubtitleSnippet[]>;
  automatic_captions?: Record<string, SubtitleSnippet[]>;
}
export interface SourceText {
  title: string; description: string; tags: string[]; language: string | null;
  subtitleLanguages: string[]; automaticCaptionLanguages: string[]; subtitleText: string;
}
export type AIProtocol = 'openai' | 'anthropic';
export interface RewriteOptions {
  protocol?: AIProtocol;
  headers?: Record<string, string>;
  systemPrompt?: string;
  apiKey?: string;
  /** API root, including /v1 if needed; never include /chat/completions. */
  baseURL?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** Disable for compatible endpoints without response_format support. No automatic paid retries. */
  jsonMode?: boolean;
  signal?: AbortSignal;
}
export interface LocalizedCopy {
  title: string; body: string; tags: string[];
  /** Required for douyin / kuaishou. */
  hook?: string;
  /** Editorial suggestion, not a platform category ID. Required for bilibili. */
  category?: string;
}
export interface PlatformRewrite extends LocalizedCopy {
  platform: TargetPlatform; model: string; generatedAt: string;
  usage?: TokenUsage; editedAt?: string;
}
export interface RewrittenDocument {
  schemaVersion: 1; taskId: string; updatedAt: string;
  source: { file: 'media.info.json'; sha256: string };
  platforms: Partial<Record<TargetPlatform, PlatformRewrite>>;
}
export type RewriteErrorCode =
  | 'INVALID_OPTIONS' | 'INVALID_PLATFORM' | 'INVALID_METADATA' | 'TASK_NOT_FOUND'
  | 'ASSET_NOT_READY' | 'STORE_LOCKED' | 'SOURCE_CHANGED' | 'CORRUPT_OUTPUT'
  | 'AUTH_ERROR' | 'RATE_LIMITED' | 'API_ERROR' | 'NETWORK_ERROR'
  | 'TIMEOUT' | 'CANCELLED' | 'INVALID_RESPONSE' | 'PERSISTENCE_ERROR';
export interface RewriteFailure { code: RewriteErrorCode; message: string; retryable: boolean; status?: number }
export interface RewriteTaskResult {
  taskId: string; state: 'completed' | 'partial' | 'failed' | 'cancelled';
  requestedPlatforms: TargetPlatform[];
  errors: Partial<Record<TargetPlatform, RewriteFailure>>;
  document?: RewrittenDocument;
  outputFile?: string;
}
export interface RewriteProgress {
  taskId: string; platform: TargetPlatform; phase: 'started' | 'saved' | 'failed';
  /** Number of requested platforms settled (saved or failed), not token progress. */
  completed: number; total: number;
}
export interface RewriterOptions extends RewriteOptions {
  dataDirectory: string;
  onProgress?: (progress: RewriteProgress) => void;
  onSuccess?: (taskId: string, result: PlatformRewrite) => void;
  onError?: (taskId: string, platform: TargetPlatform, error: RewriteFailure) => void;
}

export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }
