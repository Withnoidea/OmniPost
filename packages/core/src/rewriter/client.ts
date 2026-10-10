import { isRecord } from '../fetcher/store.js';
import { checkCancelled, RewriterError } from './errors.js';
import { buildRewriteMessages } from './prompts.js';
import { parseRewriteOutput } from './parser.js';
import type { PlatformRewrite, RewriteOptions, SourceText, TargetPlatform, TokenUsage } from './types.js';

export interface ResolvedOptions {
  protocol: 'openai' | 'anthropic'; headers: Record<string, string>; systemPrompt: string; modelsEndpoint: string;
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
      || /\/(chat\/completions|messages|models)$/.test(base.pathname.replace(/\/+$/u, ''))) throw new Error();
    const protocol = options.protocol ?? 'openai';
    if (protocol !== 'openai' && protocol !== 'anthropic') throw new Error();
    const headers = validateHeaders(options.headers ?? {});
    const systemPrompt = options.systemPrompt ?? '';
    if (typeof systemPrompt !== 'string' || systemPrompt.length > 16000) throw new Error();
    const apiKey = options.apiKey ?? '';
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /\s/u.test(apiKey)
      || (!apiKey && ['api.deepseek.com', 'api.openai.com', 'api.anthropic.com'].includes(base.hostname))) throw new Error();
    const model = options.model ?? (base.hostname === 'api.openai.com' ? 'gpt-4o-mini' : 'deepseek-chat');
    if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n]/u.test(model)) throw new Error();
    const temperature = options.temperature ?? 0.7;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const maxTokens = options.maxTokens ?? 2048;
    const jsonMode = options.jsonMode ?? true;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > (protocol === 'anthropic' ? 1 : 2)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
      || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 8192 || typeof jsonMode !== 'boolean') throw new Error();
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error();
    const root = base.href.replace(/\/+$/u, '').replace(/^(https?:\/\/[^/]+)$/, '$1/v1');
    return {
      protocol, headers, systemPrompt, modelsEndpoint: root + '/models',
      endpoint: root + (protocol === 'anthropic' ? '/messages' : '/chat/completions'), apiKey, model: model.trim(), temperature, timeoutMs, maxTokens, jsonMode,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  } catch { throw new RewriterError('INVALID_OPTIONS'); }
}
/** Routing, framing and protocol authentication cannot be overridden by custom headers. */
export function validateHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 32) throw new RewriterError('INVALID_OPTIONS');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /^(host|connection|content-length|transfer-encoding|authorization|x-api-key|content-type|accept|cookie|proxy-.*|sec-.*)$/i.test(key)
      || typeof entry !== 'string' || entry.length > 8192 || /[^\x20-\x7e]/.test(entry)) throw new RewriterError('INVALID_OPTIONS');
    result[key.toLowerCase()] = entry;
  }
  return result;
}
function requestHeaders(options: ResolvedOptions): Record<string, string> {
  return { ...options.headers, 'Content-Type': 'application/json', Accept: 'application/json',
    ...(options.protocol === 'anthropic' ? { 'anthropic-version': options.headers['anthropic-version'] ?? '2023-06-01', ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}) }
      : options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) };
}
export async function fetchModels(input: RewriteOptions, transport: LLMTransport = fetch): Promise<string[]> {
  const options = resolveRewriteOptions(input);
  const signal = AbortSignal.any([AbortSignal.timeout(Math.min(options.timeoutMs, 30000)), ...(options.signal ? [options.signal] : [])]);
  try {
    const response = await transport(options.modelsEndpoint, { headers: requestHeaders(options), signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RewriterError(response.status === 401 || response.status === 403 ? 'AUTH_ERROR' : 'API_ERROR', response.status);
    }
    const data = await responseJSON(response);
    if (!isRecord(data) || !Array.isArray(data.data)) throw new RewriterError('INVALID_RESPONSE');
    const models = [...new Set(data.data.filter(isRecord).map(item => item.id).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 200 && !/[\r\n]/.test(id)))];
    if (!models.length) throw new RewriterError('INVALID_RESPONSE');
    return models.sort();
  } catch (error) {
    checkCancelled(options.signal);
    if (signal.aborted) throw new RewriterError('TIMEOUT');
    if (error instanceof RewriterError) throw error;
    throw new RewriterError('NETWORK_ERROR');
  }
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
    const messages = buildRewriteMessages(source, platform);
    const system = messages[0]!.content + (options.systemPrompt ? `\n\n用户编辑偏好（仍须遵守上述 JSON 格式）：\n${options.systemPrompt}` : '');
    const response = await transport(options.endpoint, {
      method: 'POST', headers: requestHeaders(options), signal: controller.signal, redirect: 'error',
      body: JSON.stringify({
        model: options.model, temperature: options.temperature, max_tokens: options.maxTokens, stream: false,
        ...(options.protocol === 'anthropic'
          ? { system, messages: messages.slice(1) }
          : { messages: [{ role: 'system', content: system }, ...messages.slice(1)], ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
      }),
    });
    if (!response.ok) {
      // Never retain provider errors: they can echo prompts, credentials or internal URLs.
      await response.body?.cancel().catch(() => {});
      throw new RewriterError(response.status === 401 || response.status === 403 ? 'AUTH_ERROR' : response.status === 429 ? 'RATE_LIMITED' : 'API_ERROR', response.status);
    }
    let data = await responseJSON(response);
    if (options.protocol === 'anthropic') {
      if (!isRecord(data) || !Array.isArray(data.content) || !['end_turn', 'stop_sequence'].includes(String(data.stop_reason))) throw new RewriterError('INVALID_RESPONSE');
      const content = data.content.filter(isRecord).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
      const usage = isRecord(data.usage) ? data.usage : {};
      data = { choices: [{ finish_reason: 'stop', message: { content } }], usage: {
        prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
        total_tokens: typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' ? usage.input_tokens + usage.output_tokens : undefined,
      } };
    }
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
