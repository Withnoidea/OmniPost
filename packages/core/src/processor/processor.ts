import { randomUUID } from 'node:crypto';
import { copyFile, lstat, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, describeFile, isRecord } from '../fetcher/store.js';
import { runProcess, type ProcessRunner } from '../fetcher/process.js';
import { RewriteStore } from '../rewriter/store.js';
import { newOperation, writeOperation } from '../telemetry.js';
import type { AssetFile } from '../fetcher/types.js';
import { processingSettings, ProcessorError, type ProcessedDocument, type ProcessorConfig, type ProcessorOptions, type ProcessingProgress } from './types.js';
async function jsonFile(file: string): Promise<unknown> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new ProcessorError('ASSET_NOT_READY');
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
function isAsset(value: unknown): value is AssetFile {
  return isRecord(value) && typeof value.file === 'string' && path.basename(value.file) === value.file && typeof value.bytes === 'number' && value.bytes > 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}
/** Immutable versioned file + atomic pointer is authoritative; processed.mp4 is a recoverable export. */
export class MediaProcessor {
  private readonly store: RewriteStore;
  constructor(private readonly config: ProcessorConfig, private readonly runner: ProcessRunner = runProcess) { this.store = new RewriteStore(config.dataDirectory); }
  private report(event: ProcessingProgress): void { try { this.config.onProgress?.(event); } catch { /* UI observers never break a commit. */ } }
  private async export(directory: string, document: ProcessedDocument): Promise<void> {
    const target = path.join(directory, 'processed.mp4');
    try {
      const existing = await describeFile(directory, 'processed.mp4');
      if (existing.sha256 === document.video.sha256) return;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProcessorError('PERSISTENCE_ERROR'); }
    const temporary = `.export-${randomUUID()}.mp4`;
    try {
      await copyFile(path.join(directory, document.video.file), path.join(directory, temporary), 1);
      const actual = await describeFile(directory, temporary);
      if (actual.sha256 !== document.video.sha256) throw new ProcessorError('PERSISTENCE_ERROR');
      await rename(path.join(directory, temporary), target);
    } finally { await unlink(path.join(directory, temporary)).catch(() => {}); }
  }
  async readTask(taskId: string): Promise<ProcessedDocument | undefined> {
    const directory = await this.store.directory(taskId);
    const release = await this.store.lock(directory, 'process');
    try {
      let value: unknown;
      try { value = await jsonFile(path.join(directory, 'processed.json')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
      if (!isRecord(value) || value.taskId !== taskId || value.schemaVersion !== 1 || value.state !== 'PROCESSED_READY' || value.exportFile !== 'processed.mp4'
        || !isAsset(value.video) || !/^processed-[a-f0-9-]+\.mp4$/.test(value.video.file) || !isAsset(value.source)
        || !['width', 'height', 'durationSeconds', 'durationMs'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && (value[k] as number) > 0)) throw new ProcessorError('PERSISTENCE_ERROR');
      const document = value as unknown as ProcessedDocument;
      const actual = await describeFile(directory, document.video.file);
      if (actual.sha256 !== document.video.sha256) throw new ProcessorError('PERSISTENCE_ERROR');
      const source = await this.source(directory, taskId);
      if (source.sha256 !== document.source.sha256) throw new ProcessorError('SOURCE_CHANGED');
      await this.export(directory, document);
      return document;
    } finally { await release(); }
  }
  private async source(directory: string, taskId: string, signal?: AbortSignal): Promise<AssetFile> {
    const value = await jsonFile(path.join(directory, 'manifest.json'));
    if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== taskId || !isAsset(value.video)) throw new ProcessorError('ASSET_NOT_READY');
    const actual = await describeFile(directory, value.video.file, signal);
    if (actual.sha256 !== value.video.sha256 || actual.bytes !== value.video.bytes) throw new ProcessorError('SOURCE_CHANGED');
    return actual;
  }
  private async probe(directory: string, file: string, signal: AbortSignal): Promise<{ width: number; height: number; duration: number; audio: boolean }> {
    let raw = '';
    const result = await this.runner({ executable: this.config.tools.ffprobe, args: ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], cwd: directory, signal, onLine: line => { if (raw.length < 1024 * 1024) raw += line; } });
    try {
      const data: unknown = JSON.parse(raw);
      if (result.exitCode !== 0 || !isRecord(data) || !Array.isArray(data.streams) || !isRecord(data.format)) throw new Error();
      const video: unknown = data.streams.find((s: unknown) => isRecord(s) && s.codec_type === 'video');
      const duration = Number(data.format.duration);
      if (!isRecord(video) || typeof video.width !== 'number' || typeof video.height !== 'number' || video.width < 16 || video.height < 16 || !Number.isFinite(duration) || duration <= 0) throw new Error();
      return { width: video.width, height: video.height, duration, audio: data.streams.some((s: unknown) => isRecord(s) && s.codec_type === 'audio') };
    } catch { throw new ProcessorError('PROCESS_FAILED'); }
  }
  async processTask(taskId: string, options: ProcessorOptions = {}): Promise<ProcessedDocument> {
    const settings = processingSettings(options);
    const timeout = options.timeoutMs ?? 30 * 60_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 6 * 60 * 60_000) throw new ProcessorError('INVALID_OPTIONS');
    if (options.signal?.aborted) throw new ProcessorError('CANCELLED');
    const directory = await this.store.directory(taskId);
    const release = await this.store.lock(directory, 'process');
    const controller = new AbortController(); let timedOut = false;
    const abort = (): void => { controller.abort(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const operation = newOperation(taskId, 'process'); const started = Date.now();
    const output = `processed-${operation.id}.mp4`; let committed = false; let recorded = false;
    const check = (): void => { if (controller.signal.aborted) throw new ProcessorError(timedOut ? 'TIMEOUT' : 'CANCELLED'); };
    try {
      const source = await this.source(directory, taskId, controller.signal); check();
      await writeOperation(directory, operation); recorded = true;
      this.report({ taskId, phase: 'probing', percent: 0 });
      const info = await this.probe(directory, source.file, controller.signal);
      const factor = 1 - settings.cropPercent / 100;
      const filter = `crop=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2,eq=contrast=${settings.contrast},unsharp=5:5:${settings.sharpen}:5:5:0,setpts=(PTS-STARTPTS)/${settings.speed}`;
      const args = ['-hide_banner', '-nostdin', '-n', '-i', source.file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', filter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '2',
        ...(info.audio ? ['-af', `asetpts=PTS-STARTPTS,atempo=${settings.speed}`, '-c:a', 'aac', '-ar', '48000', '-b:a', '160k'] : []),
        '-map_metadata', '-1', '-map_chapters', '-1', '-metadata', 'encoder=', '-metadata:s:v', 'encoder=', '-metadata:s:a', 'encoder=',
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-bsf:v', 'filter_units=remove_types=6',
        '-movflags', '+faststart', '-progress', 'pipe:2', '-nostats', output];
      let percent = 0;
      const result = await this.runner({ executable: this.config.tools.ffmpeg, args, cwd: directory, signal: controller.signal, onLine: () => {}, onStderrLine: line => {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) { percent = Math.max(percent, Math.min(98, Number(match[1]) / 1_000_000 / (info.duration / settings.speed) * 100)); this.report({ taskId, phase: 'encoding', percent }); }
      } });
      check(); if (result.exitCode !== 0) throw new ProcessorError('PROCESS_FAILED');
      const produced = await this.probe(directory, output, controller.signal);
      this.report({ taskId, phase: 'committing', percent: 99 });
      const video = await describeFile(directory, output, controller.signal);
      if ((await this.source(directory, taskId, controller.signal)).sha256 !== source.sha256) throw new ProcessorError('SOURCE_CHANGED');
      check();
      const document: ProcessedDocument = { schemaVersion: 1, taskId, state: 'PROCESSED_READY', source, video, exportFile: 'processed.mp4',
        createdAt: new Date().toISOString(), width: produced.width, height: produced.height, durationSeconds: produced.duration,
        durationMs: Math.max(1, Date.now() - started), settings };
      // No cancellation beyond this point: the durable pointer is the transaction boundary.
      await atomicJson(path.join(directory, 'processed.json'), document); committed = true;
      await this.export(directory, document);
      await writeOperation(directory, { ...operation, state: 'succeeded', finishedAt: document.createdAt, durationMs: document.durationMs });
      this.report({ taskId, phase: 'ready', percent: 100 }); return document;
    } catch (error) {
      if (recorded) await writeOperation(directory, { ...operation, state: 'failed', finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
      if (error instanceof ProcessorError) throw error;
      if (controller.signal.aborted && !committed) throw new ProcessorError(timedOut ? 'TIMEOUT' : 'CANCELLED');
      throw new ProcessorError(committed ? 'PERSISTENCE_ERROR' : 'PROCESS_FAILED');
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (!committed) await unlink(path.join(directory, output)).catch(() => {});
      await release();
    }
  }
}
