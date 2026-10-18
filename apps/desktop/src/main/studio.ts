import { safeStorage } from 'electron';

import { lstat, readFile } from 'node:fs/promises';


import { AIRewriter } from '../../../../packages/core/src/rewriter/rewriter.js';

import { resolveRewriteOptions, fetchModels, validateHeaders } from '../../../../packages/core/src/rewriter/client.js';

import { validatePlatform } from '../../../../packages/core/src/rewriter/prompts.js';

import { validateCopy } from '../../../../packages/core/src/rewriter/parser.js';

import { MediaProcessor } from '../../../../packages/core/src/processor/processor.js';

import { DEFAULT_PROCESSING, processingSettings } from '../../../../packages/core/src/processor/types.js';

import { atomicJson, isRecord } from '../../../../packages/core/src/fetcher/store.js';

import type { DownloadTask, PortableTools } from '../../../../packages/core/src/fetcher/types.js';

import type { StudioSettings, SettingsInput, StudioEvent, TaskLibrary, TargetPlatform } from '../shared/contracts.js';

import { DesktopError, text } from './security.js';

export class StudioService {

  private settings: StudioSettings = { ai: { protocol: 'openai', systemPrompt: '', hasCustomHeaders: false, baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.7, jsonMode: true, hasApiKey: false, persisted: true }, processor: { ...DEFAULT_PROCESSING } };

  private apiKey = '';
  private headers: Record<string, string> = {};

  private readonly jobs = new Map<string, AbortController>();

  private readonly libraryReads = new Map<string, Promise<TaskLibrary>>();
  private readonly pending = new Set<Promise<unknown>>();

  private readonly writer: AIRewriter;

  private readonly processor: MediaProcessor;

  constructor(root: string, private readonly file: string, tools: PortableTools, private readonly emit: (event: StudioEvent) => void) {

    this.writer = new AIRewriter({ dataDirectory: root, onProgress: progress => emit({ kind: 'rewrite', progress }) });

    this.processor = new MediaProcessor({ dataDirectory: root, tools, onProgress: progress => emit({ kind: 'process', progress }) });

  }

  publicSettings(): StudioSettings { return structuredClone(this.settings); }

  private validate(input: unknown): SettingsInput {

    if (!isRecord(input) || !isRecord(input.ai) || !isRecord(input.processor)) throw new DesktopError('INVALID_SETTINGS', '设置格式无效。');

    const ai = input.ai;

    if (typeof ai.baseURL !== 'string' || typeof ai.model !== 'string' || typeof ai.temperature !== 'number' || typeof ai.jsonMode !== 'boolean'

      || (ai.apiKey !== undefined && typeof ai.apiKey !== 'string')) throw new DesktopError('INVALID_SETTINGS', '请检查 API 设置。');

    const apiKey = typeof ai.apiKey === 'string' ? ai.apiKey : this.apiKey;

    const protocol = ai.protocol ?? 'openai';
    if (protocol !== 'openai' && protocol !== 'anthropic') throw new DesktopError('INVALID_SETTINGS', '未知 AI 协议。');
    const systemPrompt = ai.systemPrompt === undefined || ai.systemPrompt === '' ? '' : text(ai.systemPrompt, 16000);
    const headers = ai.headers === undefined ? undefined : validateHeaders(ai.headers);
    const validated = { protocol: protocol as 'openai' | 'anthropic', systemPrompt, ...(headers === undefined ? {} : { headers }), baseURL: ai.baseURL.trim(), model: ai.model.trim(), temperature: ai.temperature, jsonMode: ai.jsonMode };

    // Allow saving an unconfigured official provider; actual generation still requires a real key.

    resolveRewriteOptions({ ...validated, apiKey: apiKey || 'validation-placeholder' });

    for (const key of ['speed','cropPercent','contrast','sharpen']) if (typeof input.processor[key] !== 'number') throw new DesktopError('INVALID_SETTINGS', '请检查 FFmpeg 参数。');

    const processor = processingSettings(input.processor);

    return { ai: { ...validated, ...(ai.apiKey === undefined ? {} : { apiKey }) }, processor };

  }

  async load(): Promise<void> {

    try {

      const stat = await lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return;

      const saved: unknown = JSON.parse(await readFile(this.file, 'utf8'));

      if (!isRecord(saved) || saved.schemaVersion !== 1) return;

      const next = this.validate(saved);

      let key = '';

      if (typeof saved.encryptedKey === 'string' && safeStorage.isEncryptionAvailable()) key = safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'));

      const headers = typeof saved.encryptedHeaders === 'string' && safeStorage.isEncryptionAvailable()
        ? validateHeaders(JSON.parse(safeStorage.decryptString(Buffer.from(saved.encryptedHeaders, 'base64')))) : {};
      const { apiKey: _key, headers: _headers, ...ai } = next.ai;
      this.settings = { ai: { ...ai, protocol: ai.protocol ?? 'openai', systemPrompt: ai.systemPrompt ?? '', hasCustomHeaders: Boolean(Object.keys(headers).length), hasApiKey: Boolean(key), persisted: true }, processor: next.processor };
      this.apiKey = key; this.headers = headers;

    } catch { /* Fail closed: never expose unreadable credentials or echo raw settings. */ }

  }

  async save(input: unknown): Promise<StudioSettings> {

    const next = this.validate(input);
    const sameOrigin = new URL(next.ai.baseURL).origin === new URL(this.settings.ai.baseURL).origin;
    const key = next.ai.apiKey ?? (sameOrigin ? this.apiKey : '');

    const headers = next.ai.headers ?? (sameOrigin ? this.headers : {});
    const persisted = (!key && !Object.keys(headers).length) || safeStorage.isEncryptionAvailable();

    const { apiKey: _key, headers: _headers, ...ai } = next.ai;

    await atomicJson(this.file, { schemaVersion: 1, ai, processor: next.processor, ...(Object.keys(headers).length && persisted ? { encryptedHeaders: safeStorage.encryptString(JSON.stringify(headers)).toString('base64') } : {}), ...(key && persisted ? { encryptedKey: safeStorage.encryptString(key).toString('base64') } : {}) });

    this.apiKey = key; this.headers = headers; this.settings = { ai: { ...ai, protocol: ai.protocol ?? 'openai', systemPrompt: ai.systemPrompt ?? '', hasCustomHeaders: Boolean(Object.keys(headers).length), hasApiKey: Boolean(key), persisted }, processor: next.processor };

    return this.publicSettings();

  }

  async models(input: unknown): Promise<string[]> {
    const next = this.validate({ ai: input, processor: this.settings.processor }).ai;
    const sameOrigin = new URL(next.baseURL).origin === new URL(this.settings.ai.baseURL).origin;
    return this.job('settings', 'rewrite', signal => fetchModels({ ...next, apiKey: next.apiKey ?? (sameOrigin ? this.apiKey : ''), headers: next.headers ?? (sameOrigin ? this.headers : {}), signal }));
  }
  async library(task: DownloadTask): Promise<TaskLibrary> {
    const existing = this.libraryReads.get(task.id); if (existing) return existing;
    const pending = this.readLibrary(task); this.libraryReads.set(task.id, pending);
    try { return await pending; } finally { this.libraryReads.delete(task.id); }
  }
  private async readLibrary(task: DownloadTask): Promise<TaskLibrary> {

    const active = (['rewrite', 'process'] as const).filter(kind => this.jobs.has(`${task.id}:${kind}`));

    if (!task.metadataAsset && !task.asset) return { rewritten: null, processed: null, active };

    return { rewritten: await this.writer.readTask(task.id) ?? null, processed: active.includes('process') ? null : await this.processor.readTask(task.id) ?? null, active };

  }

  private async job<T>(id: string, kind: 'rewrite' | 'process', work: (signal: AbortSignal) => Promise<T>): Promise<T> {

    const key = `${id}:${kind}`;

    if (this.jobs.has(key)) throw new DesktopError('BUSY', '当前任务正在处理中。');

    const controller = new AbortController(); this.jobs.set(key, controller);

    const pending = work(controller.signal); this.pending.add(pending);

    try { return await pending; }

    finally { this.jobs.delete(key); this.pending.delete(pending); this.emit({ kind: 'settled', taskId: id, operation: kind }); }

  }

  async rewrite(task: DownloadTask, input: unknown, mode: unknown = 'replace') {
    if (mode !== 'replace' && mode !== 'missing') throw new DesktopError('INVALID_INPUT', '未知改写模式。');

    if (!Array.isArray(input) || input.length < 1 || input.length > 4) throw new DesktopError('INVALID_PLATFORM', '请选择目标平台。');

    input.forEach(validatePlatform);

    const manifest = task.asset ?? task.metadataAsset;

    if (!manifest) throw new DesktopError('ASSET_NOT_READY', '请先解析链接。');

    const options = { ...this.settings.ai, apiKey: this.apiKey, headers: this.headers };

    return this.job(task.id, 'rewrite', signal => this.writer.rewriteMultiPlatform(manifest, input as TargetPlatform[], { ...options, skipExisting: mode === 'missing', signal }));

  }

  async edit(task: DownloadTask, platform: unknown, input: unknown, revision: unknown) {

    validatePlatform(platform);

    if (this.jobs.has(`${task.id}:rewrite`)) throw new DesktopError('BUSY', '请等待本次改写完成后保存。');

    return this.writer.saveCopy(task.id, platform, validateCopy(input, platform), text(revision, 100));

  }

  async process(task: DownloadTask) {

    if (!task.asset) throw new DesktopError('ASSET_NOT_READY', '请先挂载视频。');

    const settings = { ...this.settings.processor };

    return this.job(task.id, 'process', signal => this.processor.processTask(task.id, { ...settings, signal }));

  }

  cancel(id: string, kind: unknown): void {

    if (kind !== 'rewrite' && kind !== 'process') throw new DesktopError('INVALID_INPUT', '未知操作。');

    this.jobs.get(`${id}:${kind}`)?.abort();

  }

  async close(): Promise<void> { for (const controller of this.jobs.values()) controller.abort(); await Promise.allSettled([...this.pending]); }

}

