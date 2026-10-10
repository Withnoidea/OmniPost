import type { RewriteErrorCode, RewriteFailure } from './types.js';

const messages: Record<RewriteErrorCode, string> = {
  INVALID_OPTIONS: '改写配置不合法，请检查 API 地址、模型和参数。',
  INVALID_PLATFORM: '目标平台不受支持，或未选择平台。',
  INVALID_METADATA: '源元数据缺失、过大或没有有效标题。',
  TASK_NOT_FOUND: '任务资产目录不存在。',
  ASSET_NOT_READY: '任务尚无已提交的元数据，或资产路径不安全。',
  STORE_LOCKED: '此任务正在由其他改写操作处理，请稍后重试。',
  SOURCE_CHANGED: '源元数据已发生变化，未覆盖已有改写；请先备份并检查任务资产。',
  CORRUPT_OUTPUT: '已有改写文件损坏或格式不符，已保留原文件，请先备份并检查。',
  AUTH_ERROR: 'LLM 服务拒绝认证或访问，请检查 API Key 和权限。',
  RATE_LIMITED: 'LLM 服务限流，请稍后重试。',
  API_ERROR: 'LLM 服务请求失败，请检查端点、模型和服务状态。',
  NETWORK_ERROR: '无法连接 LLM 服务，请检查网络和地址。',
  TIMEOUT: 'LLM 改写超时，已停止请求；已保存的平台结果不受影响。',
  CANCELLED: '改写已取消，已保存的平台结果不受影响。',
  INVALID_RESPONSE: 'LLM 输出不是完整有效的平台 JSON，请重试或调整模型。',
  PERSISTENCE_ERROR: '改写资产读写失败，未主动删除已有文件。',
};
export class RewriterError extends Error implements RewriteFailure {
  readonly code: RewriteErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(code: RewriteErrorCode, status?: number) {
    super(messages[code]); this.name = 'RewriterError'; this.code = code;
    this.retryable = ['RATE_LIMITED', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE', 'STORE_LOCKED'].includes(code)
      || (code === 'API_ERROR' && status !== undefined && status >= 500);
    if (status !== undefined) this.status = status;
  }
  toJSON(): RewriteFailure {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.status === undefined ? {} : { status: this.status }) };
  }
}
export function checkCancelled(signal?: AbortSignal): void {
  // Never expose arbitrary caller-supplied abort reasons (may contain secrets).
  if (signal?.aborted) throw new RewriterError('CANCELLED');
}
export function storageError(error: unknown): RewriterError {
  return error instanceof RewriterError ? error : new RewriterError('PERSISTENCE_ERROR');
}
