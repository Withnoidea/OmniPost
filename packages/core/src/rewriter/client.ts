import { isRecord } from '../fetcher/store.js';
import { checkCancelled, RewriterError } from './errors.js';
import { buildRewriteMessages } from './prompts.js';
import { parseRewriteOutput } from './parser.js';
import type { PlatformRewrite, RewriteOptions, SourceText, TargetPlatform, TokenUsage } from './types.js';

export interface ResolvedOptions {
  endpoint: string; apiKey: string; model: string; temperature: number;
  timeoutMs: number; maxTokens: number; jsonMode: boolean; signal?: AbortSignal;
}
/** Test seam only. Production defaults to the Node built-in fetch implementation. */
export type LLMTransport = typeof fetch;
export function resolveRewriteOptions(options: RewriteOptions): ResolvedOptions {
  try {
    const base = new URL(options.baseURL ?? 'https://api.deepseek.com/v1');
    const loopback = base.hostname === 'localhost' || base.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(base.hostname);
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash
      || base.pathname.replace(/\/+$/u, '').endsWith('/chat/completions')) throw new Error();
    const apiKey = options.apiKey ?? '';
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /\s/u.test(apiKey)
      || (!apiKey && ['api.deepseek.com', 'api.openai.com'].includes(base.hostname))) throw new Error();
    const model = options.model ?? (base.hostname === 'api.openai.com' ? 'gpt-4o-mini' : 'deepseek-chat');
    if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n]/u.test(model)) throw new Error();
    const temperature = options.temperature ?? 0.7;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const maxTokens = options.maxTokens ?? 2048;
    const jsonMode = options.jsonMode ?? true;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
      || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 8192 || typeof jsonMode !== 'boolean') throw new Error();
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error();
    return {
      endpoint: base.href.replace(/\/+$/u, '') + '/chat/completions', apiKey, model: model.trim(), temperature, timeoutMs, maxTokens, jsonMode,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  } catch { throw new RewriterError('INVALID_OPTIONS'); }
}
async function responseJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new RewriterError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 1024 * 1024) throw new RewriterError('INVALID_RESPONSE');
      buffers.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown; }
  catch { throw new RewriterError('INVALID_RESPONSE'); }
}
export async function requestRewrite(source: SourceText, platform: TargetPlatform, options: ResolvedOptions, transport: LLMTransport = fetch, onUsage?: (usage: TokenUsage) => void): Promise<PlatformRewrite> {
  checkCancelled(options.signal);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => { controller.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await transport(options.endpoint, {
      method: 'POST', headers, signal: controller.signal, redirect: 'error',
      body: JSON.stringify({
        model: options.model, temperature: options.temperature, max_tokens: options.maxTokens, stream: false,
        messages: buildRewriteMessages(source, platform),
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!response.ok) {
      // Never retain provider errors: they can echo prompts, credentials or internal URLs.
      await response.body?.cancel().catch(() => {});
      throw new RewriterError(response.status === 401 || response.status === 403 ? 'AUTH_ERROR' : response.status === 429 ? 'RATE_LIMITED' : 'API_ERROR', response.status);
    }
    const data = await responseJSON(response);
    if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) throw new RewriterError('INVALID_RESPONSE');
    let usage: TokenUsage | undefined;
    if (isRecord(data.usage)) {
      const u = data.usage;
      if ([u.prompt_tokens, u.completion_tokens, u.total_tokens].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
        usage = { promptTokens: u.prompt_tokens as number, completionTokens: u.completion_tokens as number, totalTokens: u.total_tokens as number };
        onUsage?.(usage);
      }
    }
    const choice = data.choices[0];
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' || !isRecord(choice.message)
      || choice.message.refusal || typeof choice.message.content !== 'string') throw new RewriterError('INVALID_RESPONSE');
    const copy = parseRewriteOutput(choice.message.content, platform);
    if (timedOut) throw new RewriterError('TIMEOUT');
    checkCancelled(options.signal);
    return { ...copy, platform, model: options.model, generatedAt: new Date().toISOString(), ...(usage ? { usage } : {}) };
  } catch (error) {
    checkCancelled(options.signal);
    if (timedOut) throw new RewriterError('TIMEOUT');
    if (error instanceof RewriterError) throw error;
    throw new RewriterError('NETWORK_ERROR');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
