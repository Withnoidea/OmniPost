import type { ErrorCode, Failure } from './types.js';

const messages: Record<ErrorCode, string> = {
  INVALID_MEDIA: '本地媒体不可用，请选择已下载完成的非空 MP4 文件。',
  INVALID_STATE: '任务未处于等待媒体状态，或已有媒体绑定操作正在进行。',
  INVALID_URL: '仅支持有效的 YouTube 或 TikTok 单视频链接。',
  INVALID_PROXY: '代理必须是有效的 HTTP、HTTPS、SOCKS5 或 SOCKS5H URL。',
  INVALID_OPTIONS: '下载配置不合法。',
  TOOL_NOT_FOUND: '便携工具缺失或不可执行，请重新准备应用内置工具。',
  SPAWN_FAILED: '无法启动便携下载工具。',
  DOWNLOAD_FAILED: '源站下载失败，工作目录已保留。',
  NETWORK_ERROR: '网络或代理连接失败，请检查代理后重试。',
  AUTH_REQUIRED: '源站要求登录或人工验证，本模块不会绕过验证。',
  RATE_LIMITED: '源站请求限流，请稍后重试。',
  UNAVAILABLE: '视频不可用、受地区限制、为直播或不受支持。',
  TIMEOUT: '任务超时，已停止子进程并保留工作目录。',
  CANCELLED: '任务已取消，工作目录已保留。',
  INVALID_OUTPUT: '下载产物不完整或格式异常，未提交为可用资产。',
  PERSISTENCE_ERROR: '本地存储读写失败，已有文件未删除。',
  INTERRUPTED: '上次进程异常退出，未完成任务已保留；请手动重试。',
  STORE_LOCKED: '同一数据目录已被其他调度器占用。',
  SCHEDULER_CLOSED: '下载调度器已关闭。',
};
const retryable = new Set<ErrorCode>(['DOWNLOAD_FAILED', 'NETWORK_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'INTERRUPTED']);
export class FetcherError extends Error implements Failure {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode) {
    super(messages[code]);
    this.name = 'FetcherError';
    this.code = code;
    this.retryable = retryable.has(code);
  }
  toJSON(): Failure { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
export function asFetcherError(error: unknown, fallback: ErrorCode = 'PERSISTENCE_ERROR'): FetcherError {
  return error instanceof FetcherError ? error : new FetcherError(fallback);
}
export function classifyDownloadError(stderr: string): FetcherError {
  // Raw stderr can contain credentials, signed URLs and cookies: never persist or emit it.
  if (/429|too many requests|rate.?limit/i.test(stderr)) return new FetcherError('RATE_LIMITED');
  if (/sign in|log.?in|captcha|not a bot|cookies.*required|authentication|private video|age.restrict/i.test(stderr)) return new FetcherError('AUTH_REQUIRED');
  if (/timed? out|proxy|connection|network|unable to download webpage|name resolution|resolve host/i.test(stderr)) return new FetcherError('NETWORK_ERROR');
  if (/unavailable|not available|removed|copyright|geo.?restrict|unsupported url|live.*filter|does not pass filter/i.test(stderr)) return new FetcherError('UNAVAILABLE');
  return new FetcherError('DOWNLOAD_FAILED');
}
export function abortError(signal: AbortSignal): FetcherError {
  return signal.reason instanceof FetcherError ? signal.reason : new FetcherError('CANCELLED');
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}
