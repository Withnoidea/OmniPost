import path from 'node:path';
import type { MetadataManifest } from '../fetcher/types.js';
import { newOperation, writeOperation } from '../telemetry.js';
import { validateCopy } from './parser.js';
import { requestRewrite, resolveRewriteOptions, type LLMTransport } from './client.js';
import { checkCancelled, RewriterError } from './errors.js';
import { extractSourceText } from './metadata.js';
import { validatePlatform } from './prompts.js';
import { RewriteStore } from './store.js';
import type { LocalizedCopy, PlatformRewrite, RewrittenDocument, RewriterOptions, RewriteInput, RewriteOptions, RewriteTaskResult, TargetPlatform } from './types.js';

/** Stateless API: no file IO. Failures reject with a sanitized RewriterError. */
export async function rewriteSinglePlatform(inputMeta: RewriteInput, platform: TargetPlatform, options: RewriteOptions = {}): Promise<PlatformRewrite> {
  validatePlatform(platform);
  return requestRewrite(extractSourceText(inputMeta), platform, resolveRewriteOptions(options));
}
export class AIRewriter {
  private readonly store: RewriteStore;
  private readonly options: RewriterOptions;
  constructor(options: RewriterOptions, private readonly transport: LLMTransport = fetch) {
    this.options = { ...options };
    this.store = new RewriteStore(options.dataDirectory);
  }
  async rewriteSinglePlatform(inputMeta: RewriteInput, platform: TargetPlatform, options: RewriteOptions = {}): Promise<PlatformRewrite> {
    validatePlatform(platform);
    return requestRewrite(extractSourceText(inputMeta), platform, resolveRewriteOptions({ ...this.options, ...options }), this.transport);
  }
  /** Resolve the committed task source rather than trusting caller-supplied text or file paths. */
  async rewriteMultiPlatform(manifest: MetadataManifest, platforms: TargetPlatform[], options: RewriteOptions = {}): Promise<RewriteTaskResult> {
    return this.rewriteTask(manifest.taskId, platforms, options);
  }
  async readTask(taskId: string): Promise<RewrittenDocument | undefined> {
    const directory = await this.store.directory(taskId);
    const source = await this.store.source(directory, taskId);
    return this.store.load(directory, taskId, source.sha256);
  }
  async saveCopy(taskId: string, platform: TargetPlatform, copy: LocalizedCopy, expectedUpdatedAt: string): Promise<RewrittenDocument> {
    validatePlatform(platform);
    const validated = validateCopy(copy, platform);
    const directory = await this.store.directory(taskId);
    const release = await this.store.lock(directory);
    try {
      const source = await this.store.source(directory, taskId);
      const document = await this.store.load(directory, taskId, source.sha256);
      const previous = document?.platforms[platform];
      if (!document || !previous) throw new RewriterError('ASSET_NOT_READY');
      if (document.updatedAt !== expectedUpdatedAt) throw new RewriterError('SOURCE_CHANGED');
      const now = new Date(Math.max(Date.now(), Date.parse(document.updatedAt) + 1)).toISOString();
      const next: RewrittenDocument = { ...document, updatedAt: now, platforms: { ...document.platforms, [platform]: { ...previous, ...validated, editedAt: now } } };
      await this.store.save(directory, next);
      return next;
    } finally { await release(); }
  }
  async rewriteTask(taskId: string, targetPlatforms: TargetPlatform[], options: RewriteOptions = {}): Promise<RewriteTaskResult> {
    if (!Array.isArray(targetPlatforms) || targetPlatforms.length === 0 || targetPlatforms.length > 16) throw new RewriterError('INVALID_PLATFORM');
    targetPlatforms.forEach(validatePlatform);
    const platforms = [...new Set(targetPlatforms)];
    const config = resolveRewriteOptions({ ...this.options, ...options });
    checkCancelled(config.signal);
    const directory = await this.store.directory(taskId);
    const release = await this.store.lock(directory);
    try {
      const source = await this.store.source(directory, taskId);
      let document = await this.store.load(directory, taskId, source.sha256);
      const outcome: RewriteTaskResult = { taskId, state: 'failed', requestedPlatforms: platforms, errors: {} };
      let saved = 0;
      let completed = 0;
      for (const platform of platforms) {
        if (config.signal?.aborted) { outcome.errors[platform] = new RewriterError('CANCELLED').toJSON(); continue; }
        let rewritten: PlatformRewrite;
        const operation = newOperation(taskId, 'rewrite', platform);
        await writeOperation(directory, operation);
        const started = Date.now();
        this.observe(() => this.options.onProgress?.({ taskId, platform, phase: 'started', completed, total: platforms.length }));
        try { rewritten = await requestRewrite(source.text, platform, config, this.transport, usage => { operation.usage = usage; }); }
        catch (error) {
          const failure = (error instanceof RewriterError ? error : new RewriterError('API_ERROR')).toJSON();
          await writeOperation(directory, { ...operation, state: 'failed', finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
          outcome.errors[platform] = failure;
          completed++;
          this.observe(() => this.options.onError?.(taskId, platform, structuredClone(failure)));
          this.observe(() => this.options.onProgress?.({ taskId, platform, phase: 'failed', completed, total: platforms.length }));
          continue;
        }
        const next: RewrittenDocument = {
          schemaVersion: 1, taskId, updatedAt: new Date().toISOString(), source: { file: 'media.info.json', sha256: source.sha256 },
          platforms: { ...document?.platforms, [platform]: rewritten },
        };
        // Commit boundary: do not roll back a saved result if cancellation arrives during fsync/rename.
        // Persistence/source-integrity failures abort the operation, avoiding further billable calls.
        await this.store.save(directory, next);
        await writeOperation(directory, { ...operation, state: 'succeeded', finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
        document = next; saved++; completed++;
        this.observe(() => this.options.onSuccess?.(taskId, structuredClone(rewritten)));
        this.observe(() => this.options.onProgress?.({ taskId, platform, phase: 'saved', completed, total: platforms.length }));
      }
      outcome.state = saved === platforms.length ? 'completed' : config.signal?.aborted ? 'cancelled' : saved > 0 ? 'partial' : 'failed';
      if (document) { outcome.document = structuredClone(document); outcome.outputFile = path.join(directory, 'rewritten.json'); }
      return outcome;
    } finally { await release(); }
  }
  private observe(callback: () => void): void {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* UI observers cannot break durable work. */ }
  }
}

export function rewriteMultiPlatform(manifest: MetadataManifest, platforms: TargetPlatform[], options: RewriterOptions): Promise<RewriteTaskResult> {
  return new AIRewriter(options).rewriteMultiPlatform(manifest, platforms);
}
