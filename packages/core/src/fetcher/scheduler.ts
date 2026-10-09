import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { integerOption, normalizeProxy, normalizeSource, validateTools } from './config.js';
import { downloadIntoWorkspace, fetchMetadataIntoWorkspace, prepareManifest, prepareMetadataManifest, verifyVideo } from './downloader.js';
import { abortError, asFetcherError, FetcherError, throwIfAborted } from './errors.js';
import { runProcess, type ProcessRunner } from './process.js';
import { AssetStore, describeFile } from './store.js';
import type { DownloadEvent, DownloadRequest, DownloadTask, MetadataOptions, SchedulerOptions, TaskMode, TaskState } from './types.js';

const terminal = (state: TaskState): boolean => ['completed', 'failed', 'cancelled', 'interrupted', 'AWAITING_MEDIA', 'READY'].includes(state);
type PendingInput =
  | { kind: TaskMode; proxy: string; timeoutMs: number }
  | { kind: 'attachment'; localFilePath: string; timeoutMs: number };
export class DownloadScheduler {
  private readonly store: AssetStore;
  private readonly tasks = new Map<string, DownloadTask>();
  private readonly inputs = new Map<string, PendingInput>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeKinds = new Map<string, PendingInput['kind']>();
  private readonly attachments = new Map<string, Promise<DownloadTask>>();
  private readonly workers = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Array<(task: DownloadTask) => void>>();
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly metadataTimeoutMs: number;
  private readonly socketTimeoutSeconds: number;
  private readonly retries: number;
  private closed = false;
  private pendingEnqueues = new Set<Promise<DownloadTask>>();
  private closing?: Promise<void>;
  private constructor(private readonly options: SchedulerOptions, private readonly runner: ProcessRunner) {
    this.store = new AssetStore(options.dataDirectory);
    this.concurrency = integerOption(options.concurrency ?? 2, 1, 8);
    this.timeoutMs = integerOption(options.timeoutMs ?? 30 * 60_000, 1, 24 * 60 * 60_000);
    this.metadataTimeoutMs = integerOption(options.metadataTimeoutMs ?? 15_000, 1, 24 * 60 * 60_000);
    this.socketTimeoutSeconds = integerOption(options.socketTimeoutSeconds ?? 30, 1, 300);
    this.retries = integerOption(options.retries ?? 3, 0, 10);
  }
  /** runner is a test seam. Production callers should omit it. */
  static async create(options: SchedulerOptions, runner: ProcessRunner = runProcess): Promise<DownloadScheduler> {
    const scheduler = new DownloadScheduler({ ...options, tools: { ...options.tools } }, runner);
    try {
      await scheduler.store.initialize();
      for (const task of await scheduler.store.loadTasks()) {
        if (!terminal(task.state) || (task.mode === 'metadata' && task.state !== 'READY')) {
          // Both metadata-only and full manifests can precede their journal update after a crash.
          const asset = await scheduler.store.committedAsset(task.id);
          const metadata = task.mode === 'metadata' ? await scheduler.store.committedMetadata(task.id) : undefined;
          if (asset) { task.state = task.mode === 'metadata' ? 'READY' : 'completed'; task.asset = asset; delete task.error; }
          else if (metadata) {
            if (task.state === 'attaching' || task.state === 'queued') task.error = new FetcherError('INTERRUPTED').toJSON();
            task.state = 'AWAITING_MEDIA'; task.metadataAsset = metadata;
          } else if (!terminal(task.state)) { task.state = 'interrupted'; task.error = new FetcherError('INTERRUPTED').toJSON(); }
          task.updatedAt = new Date().toISOString();
          await scheduler.store.save(task);
        }
        scheduler.tasks.set(task.id, task);
      }
      return scheduler;
    } catch (error) { await scheduler.store.close(); throw asFetcherError(error); }
  }
  getAssetDirectory(id: string): string { return this.store.assetDirectory(id); }
  getWorkDirectory(id: string): string { return this.store.workDirectory(id); }
  getTask(id: string): DownloadTask | undefined { const task = this.tasks.get(id); return task ? structuredClone(task) : undefined; }
  listTasks(): DownloadTask[] { return [...this.tasks.values()].map((task) => structuredClone(task)); }
  enqueue(request: DownloadRequest): Promise<DownloadTask> { return this.enqueueMode(request, 'download'); }
  /** Resolves after metadata + cover are durable (or returns a failed/cancelled task), never downloads video. */
  async fetchMetadata(url: string, options: MetadataOptions = {}): Promise<DownloadTask> {
    const task = await this.enqueueMode({ ...options, url }, 'metadata');
    return this.waitFor(task.id);
  }
  private trackEnqueue(operation: Promise<DownloadTask>): Promise<DownloadTask> {
    this.pendingEnqueues.add(operation);
    void operation.then(() => this.pendingEnqueues.delete(operation), () => this.pendingEnqueues.delete(operation));
    return operation;
  }
  private enqueueMode(request: DownloadRequest, mode: TaskMode): Promise<DownloadTask> {
    if (this.closed) return Promise.reject(new FetcherError('SCHEDULER_CLOSED'));
    return this.trackEnqueue(this.add(request, mode));
  }
  private async add(request: DownloadRequest, mode: TaskMode): Promise<DownloadTask> {
    const source = normalizeSource(request.url);
    const proxy = normalizeProxy(request.proxy);
    const timeoutMs = integerOption(request.timeoutMs ?? (mode === 'metadata' ? this.metadataTimeoutMs : this.timeoutMs), 1, 24 * 60 * 60_000);
    await validateTools(this.options.tools, mode);
    const now = new Date().toISOString();
    const task: DownloadTask = { schemaVersion: 1, id: randomUUID(), sourceUrl: source.url, platform: source.platform, mode, state: 'queued', createdAt: now, updatedAt: now };
    try { await this.store.save(task); } catch (error) { throw asFetcherError(error); }
    this.tasks.set(task.id, task);
    this.inputs.set(task.id, { kind: mode, proxy, timeoutMs });
    this.emit({ type: 'state', task });
    const snapshot = structuredClone(task);
    this.pump();
    return snapshot;
  }
  /** Copies a local MP4; the caller's file and previously committed metadata are never modified. */
  attachLocalMedia(id: string, localFilePath: string): Promise<DownloadTask> {
    if (this.closed) return Promise.reject(new FetcherError('SCHEDULER_CLOSED'));
    const task = this.tasks.get(id);
    if (!task || task.state !== 'AWAITING_MEDIA' || this.controllers.has(id) || this.attachments.has(id)) return Promise.reject(new FetcherError('INVALID_STATE'));
    const enqueuing = this.trackEnqueue(this.addAttachment(task, localFilePath));
    this.attachments.set(id, enqueuing);
    void enqueuing.then(() => this.attachments.delete(id), () => this.attachments.delete(id));
    return enqueuing.then(() => this.waitFor(id));
  }
  private async addAttachment(task: DownloadTask, localFilePath: string): Promise<DownloadTask> {
    await validateTools(this.options.tools, 'attachment');
    if (typeof localFilePath !== 'string' || path.extname(localFilePath).toLowerCase() !== '.mp4') throw new FetcherError('INVALID_MEDIA');
    const previous = structuredClone(task);
    task.state = 'queued'; task.updatedAt = new Date().toISOString(); delete task.error;
    try { await this.store.save(task); }
    catch (error) { Object.assign(task, previous); throw asFetcherError(error); }
    this.inputs.set(task.id, { kind: 'attachment', localFilePath: path.resolve(localFilePath), timeoutMs: this.timeoutMs });
    this.emit({ type: 'state', task });
    const snapshot = structuredClone(task);
    this.pump();
    return snapshot;
  }
  /** Always creates a new task, never overwrites or removes the old workspace. Proxy must be provided again. */
  async retry(id: string, overrides: Omit<DownloadRequest, 'url'> = {}): Promise<DownloadTask> {
    const task = this.tasks.get(id);
    if (!task || !['failed', 'cancelled', 'interrupted'].includes(task.state)) throw new FetcherError('INVALID_OPTIONS');
    return this.enqueueMode({ ...overrides, url: task.sourceUrl }, task.mode ?? 'download');
  }
  async waitFor(id: string): Promise<DownloadTask> {
    const enqueuing = this.attachments.get(id);
    if (enqueuing) { await enqueuing.catch(() => undefined); return this.waitFor(id); }
    const task = this.tasks.get(id);
    if (!task) throw new FetcherError('INVALID_OPTIONS');
    // Terminal states are only exposed once their journal write has completed.
    if (terminal(task.state) && !this.controllers.has(id)) return structuredClone(task);
    return new Promise((resolve) => { const waiters = this.waiters.get(id) ?? []; waiters.push(resolve); this.waiters.set(id, waiters); });
  }
  async cancel(id: string): Promise<void> {
    // A known metadata task may be cancelled while attachment preflight/journaling is still pending.
    const enqueuing = this.attachments.get(id);
    if (enqueuing) { await enqueuing.catch(() => undefined); return this.cancel(id); }
    const task = this.tasks.get(id);
    if (!task) return;
    if (terminal(task.state)) {
      if (this.controllers.has(id)) await this.waitFor(id);
      return;
    }
    const controller = this.controllers.get(id);
    if (controller) { controller.abort(new FetcherError('CANCELLED')); await this.waitFor(id); return; }
    // Reserve a controller while persisting, so waitFor/close cannot race journal completion.
    this.controllers.set(id, new AbortController());
    task.state = this.inputs.get(id)?.kind === 'attachment' ? 'AWAITING_MEDIA' : 'cancelled';
    task.error = new FetcherError('CANCELLED').toJSON();
    this.inputs.delete(id);
    await this.finish(task);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.pendingEnqueues]);
      await Promise.all([...this.tasks.keys()].map((id) => this.cancel(id)));
      await Promise.all([...this.workers]);
      this.inputs.clear();
      await this.store.close();
    })();
    return this.closing;
  }
  private pump(): void {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      if (task.state !== 'queued') continue;
      const input = this.inputs.get(task.id);
      if (!input) continue;
      // Metadata gets its own bounded lane, so long video downloads never occupy its slots.
      const metadataLane = input.kind === 'metadata';
      const active = [...this.activeKinds.values()].filter((kind) => (kind === 'metadata') === metadataLane).length;
      if (active >= this.concurrency) continue;
      this.inputs.delete(task.id);
      const controller = new AbortController();
      this.controllers.set(task.id, controller);
      this.activeKinds.set(task.id, input.kind);
      const worker = this.execute(task, input, controller);
      this.workers.add(worker);
      void worker.finally(() => { this.workers.delete(worker); this.pump(); });
    }
  }
  private async execute(task: DownloadTask, input: PendingInput, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(new FetcherError('TIMEOUT')), input.timeoutMs);
    let committed = false;
    try {
      if (input.kind === 'attachment') {
        await this.transition(task, 'attaching');
        const metadata = await this.store.committedMetadata(task.id);
        if (!metadata) throw new FetcherError('INVALID_OUTPUT');
        const directory = await this.store.stageLocalMedia(task.id, input.localFilePath, controller.signal);
        await verifyVideo(directory, 'media.mp4', this.options.tools, this.runner, controller.signal, true);
        const video = await describeFile(directory, 'media.mp4', controller.signal);
        const manifest = { ...metadata, video: { ...video, file: `media.${path.basename(directory)}.mp4` } };
        throwIfAborted(controller.signal);
        await this.store.commitAttachment(task.id, directory, manifest);
        committed = true; task.asset = manifest; task.state = 'READY'; delete task.error;
      } else {
        await this.transition(task, input.kind === 'metadata' ? 'fetching_metadata' : 'downloading');
        throwIfAborted(controller.signal);
        const directory = await this.store.createWorkspace(task.id);
        if (input.kind === 'metadata') {
          await fetchMetadataIntoWorkspace(task, input.proxy, directory, {
            tools: this.options.tools, socketTimeoutSeconds: Math.min(5, this.socketTimeoutSeconds), retries: 0,
          }, this.runner, controller.signal);
          await this.transition(task, 'finalizing');
          const metadata = await prepareMetadataManifest(task, directory, controller.signal);
          throwIfAborted(controller.signal);
          await this.store.commitMetadata(task.id, metadata);
          committed = true; task.metadataAsset = metadata; task.state = 'AWAITING_MEDIA'; delete task.error;
        } else {
          const video = await downloadIntoWorkspace(task, input.proxy, directory, {
            tools: this.options.tools, socketTimeoutSeconds: this.socketTimeoutSeconds, retries: this.retries,
          }, this.runner, controller.signal, (progress) => {
            task.progress = progress;
            this.emit({ type: 'progress', taskId: task.id, progress });
          });
          await this.transition(task, 'finalizing');
          await verifyVideo(directory, video, this.options.tools, this.runner, controller.signal);
          const manifest = await prepareManifest(task, directory, video, controller.signal);
          throwIfAborted(controller.signal);
          // Point of no return: cancellation after this check cannot undo a committed asset.
          await this.store.commit(task.id, manifest);
          committed = true; task.asset = manifest; task.state = 'completed'; delete task.error;
        }
      }
    } catch (error) {
      const failure = controller.signal.aborted ? abortError(controller.signal) : asFetcherError(error);
      task.state = input.kind === 'attachment' && task.metadataAsset ? 'AWAITING_MEDIA' : failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
      task.error = failure.toJSON();
    } finally {
      clearTimeout(timer);
      if (input.kind !== 'attachment') input.proxy = '';
      await this.finish(task, committed);
    }
  }
  private async transition(task: DownloadTask, state: TaskState): Promise<void> {
    task.state = state;
    task.updatedAt = new Date().toISOString();
    try { await this.store.save(task); } catch (error) { throw asFetcherError(error); }
    this.emit({ type: 'state', task });
  }
  private async finish(task: DownloadTask, committed = false): Promise<void> {
    task.updatedAt = new Date().toISOString();
    try { await this.store.save(task); }
    catch {
      // Never report success until the journal is durable. A committed manifest can recover on restart.
      task.state = 'failed';
      task.error = new FetcherError('PERSISTENCE_ERROR').toJSON();
      if (!committed) delete task.asset;
    }
    this.controllers.delete(task.id);
    this.activeKinds.delete(task.id);
    this.emit({ type: 'state', task });
    if ((task.state === 'completed' || task.state === 'READY') && task.asset) this.emit({ type: 'success', task, asset: task.asset });
    else if (task.state === 'AWAITING_MEDIA' && task.metadataAsset && !task.error) this.emit({ type: 'metadata', task, metadata: task.metadataAsset });
    else if (task.error) this.emit({ type: 'failure', task, error: task.error });
    for (const resolve of this.waiters.get(task.id) ?? []) resolve(structuredClone(task));
    this.waiters.delete(task.id);
  }
  private emit(event: DownloadEvent): void {
    const safely = (callback: () => void): void => { try { void Promise.resolve(callback()).catch(() => {}); } catch { /* UI observers must not corrupt the queue */ } };
    safely(() => this.options.onEvent?.(structuredClone(event)));
    if (event.type === 'progress') safely(() => this.options.onProgress?.(event.taskId, structuredClone(event.progress)));
    if (event.type === 'metadata') safely(() => this.options.onMetadata?.(structuredClone(event.task), structuredClone(event.metadata)));
    if (event.type === 'success') safely(() => this.options.onSuccess?.(structuredClone(event.task), structuredClone(event.asset)));
    if (event.type === 'failure') safely(() => this.options.onError?.(structuredClone(event.task), structuredClone(event.error)));
  }
}
