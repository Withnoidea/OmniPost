import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, unlink, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FetcherError, throwIfAborted } from './errors.js';
import type { AssetFile, AssetManifest, DownloadTask, MetadataManifest } from './types.js';

export const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function atomicJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function describeFile(directory: string, file: string, signal?: AbortSignal): Promise<AssetFile> {
  if (path.basename(file) !== file) throw new FetcherError('INVALID_OUTPUT');
  const full = path.join(directory, file);
  const stat = await lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new FetcherError('INVALID_OUTPUT');
  if (path.dirname(await realpath(full)) !== await realpath(directory)) throw new FetcherError('INVALID_OUTPUT');
  // Flush externally-written media before announcing a durable asset.
  const handle = await open(full, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  const hash = createHash('sha256');
  const stream = createReadStream(full);
  const abort = (): void => { stream.destroy(new FetcherError('CANCELLED')); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal) throwIfAborted(signal);
    for await (const chunk of stream) { if (signal) throwIfAborted(signal); hash.update(chunk as Buffer); }
    return { file, bytes: stat.size, sha256: hash.digest('hex') };
  } finally { signal?.removeEventListener('abort', abort); stream.destroy(); }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class AssetStore {
  readonly root: string;
  private lockFile?: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private jobPath(id: string): string {
    if (!TASK_ID.test(id)) throw new FetcherError('INVALID_OPTIONS');
    return path.join(this.root, 'jobs', `${id}.json`);
  }
  workDirectory(id: string): string { this.jobPath(id); return path.join(this.root, 'work', id); }
  assetDirectory(id: string): string { this.jobPath(id); return path.join(this.root, 'assets', id); }
  async initialize(): Promise<void> {
    for (const directory of ['', 'jobs', 'work', 'assets', 'locks']) await mkdir(path.join(this.root, directory), { recursive: true, mode: 0o700 });
    // Each contender creates its own marker before scanning. Stale PID markers are ignored,
    // never deleted by competitors (avoids the stale-lock unlink/acquire race).
    this.lockFile = path.join(this.root, 'locks', `${process.pid}-${randomUUID()}.lock`);
    const handle = await open(this.lockFile, 'wx', 0o600);
    await handle.close();
    try {
      for (const name of await readdir(path.join(this.root, 'locks'))) {
        const match = /^(\d+)-[a-f0-9-]+\.lock$/.exec(name);
        if (match && path.join(this.root, 'locks', name) !== this.lockFile && processAlive(Number(match[1]))) throw new FetcherError('STORE_LOCKED');
      }
    } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    if (this.lockFile) { await unlink(this.lockFile); delete this.lockFile; }
  }
  async remove(id: string): Promise<void> {
    const job = this.jobPath(id);
    const work = this.workDirectory(id);
    const asset = this.assetDirectory(id);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(asset, { recursive: true, force: true }).catch(() => undefined);
    await rm(job, { force: true }).catch(() => undefined);
  }
  async save(task: DownloadTask): Promise<void> { await atomicJson(this.jobPath(task.id), task); }
  async createWorkspace(id: string): Promise<string> {
    const directory = this.workDirectory(id);
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }
  async loadTasks(): Promise<DownloadTask[]> {
    const tasks: DownloadTask[] = [];
    for (const name of await readdir(path.join(this.root, 'jobs'))) {
      if (!name.endsWith('.json')) continue;
      const value = await readJson(path.join(this.root, 'jobs', name));
      if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !TASK_ID.test(value.id) || name !== `${value.id}.json`
        || typeof value.sourceUrl !== 'string' || !['youtube', 'tiktok', 'local'].includes(String(value.platform))
        || !['queued', 'downloading', 'finalizing', 'completed', 'failed', 'cancelled', 'interrupted', 'fetching_metadata', 'attaching', 'AWAITING_MEDIA', 'READY'].includes(String(value.state))
        || (value.mode !== undefined && value.mode !== 'metadata' && value.mode !== 'download')
        || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new FetcherError('PERSISTENCE_ERROR');
      tasks.push(value as unknown as DownloadTask);
    }
    return tasks;
  }
  async committedMetadata(id: string): Promise<MetadataManifest | undefined> {
    const directory = this.assetDirectory(id);
    let data: unknown;
    try { data = await readJson(path.join(directory, 'metadata.manifest.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!isRecord(data) || data.schemaVersion !== 1 || data.taskId !== id || !isRecord(data.thumbnail)
      || typeof data.thumbnail.file !== 'string' || !isRecord(data.metadata)) throw new FetcherError('INVALID_OUTPUT');
    const actual = await describeFile(directory, data.thumbnail.file);
    if (actual.bytes !== data.thumbnail.bytes || actual.sha256 !== data.thumbnail.sha256) throw new FetcherError('INVALID_OUTPUT');
    await readJson(path.join(directory, 'media.info.json'));
    await readJson(path.join(directory, 'metadata.json'));
    return data as unknown as MetadataManifest;
  }
  async commitMetadata(id: string, manifest: MetadataManifest): Promise<void> {
    await atomicJson(path.join(this.workDirectory(id), 'metadata.manifest.json'), manifest);
    await rename(this.workDirectory(id), this.assetDirectory(id));
  }
  /** Copy, never move/link the user's source. Each attempt has its own retained workspace. */
  async stageLocalMedia(id: string, localFilePath: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    if (typeof localFilePath !== 'string' || path.extname(localFilePath).toLowerCase() !== '.mp4') throw new FetcherError('INVALID_MEDIA');
    const source = path.resolve(localFilePath);
    let handle;
    try {
      const entry = await lstat(source);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new Error();
      handle = await open(source, 'r');
    } catch { throw new FetcherError('INVALID_MEDIA'); }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size === 0) throw new FetcherError('INVALID_MEDIA');
      const directory = path.join(this.workDirectory(id), 'attachments', randomUUID());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, 'media.mp4.part');
      await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      throwIfAborted(signal);
      const after = await handle.stat();
      const copied = await lstat(temporary);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || copied.size !== before.size) throw new FetcherError('INVALID_MEDIA');
      await rename(temporary, path.join(directory, 'media.mp4'));
      return directory;
    } finally { await handle.close(); }
  }
  async commitAttachment(id: string, directory: string, manifest: AssetManifest): Promise<void> {
    // Unique final names retain a previous uncommitted attempt after any crash/write failure.
    const file = `media.${path.basename(directory)}.mp4`;
    if (!TASK_ID.test(path.basename(directory)) || manifest.video.file !== file
      || path.dirname(directory) !== path.join(this.workDirectory(id), 'attachments')) throw new FetcherError('INVALID_OUTPUT');
    await rename(path.join(directory, 'media.mp4'), path.join(this.assetDirectory(id), file));
    // READY is determined by this full manifest, never by the mere presence of an MP4.
    await atomicJson(path.join(this.assetDirectory(id), 'manifest.json'), manifest);
  }
  async committedAsset(id: string): Promise<AssetManifest | undefined> {
    const directory = this.assetDirectory(id);
    let data: unknown;
    try { data = await readJson(path.join(directory, 'manifest.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!isRecord(data) || data.schemaVersion !== 1 || data.taskId !== id || !isRecord(data.video) || !isRecord(data.thumbnail)) throw new FetcherError('INVALID_OUTPUT');
    for (const entry of [data.video, data.thumbnail]) {
      if (typeof entry.file !== 'string') throw new FetcherError('INVALID_OUTPUT');
      const actual = await describeFile(directory, entry.file);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new FetcherError('INVALID_OUTPUT');
    }
    await readJson(path.join(directory, 'metadata.json'));
    await readJson(path.join(directory, 'media.info.json'));
    return data as unknown as AssetManifest;
  }
  async commit(id: string, manifest: AssetManifest): Promise<void> {
    // Manifest becomes visible with the entire directory, on the same filesystem.
    await atomicJson(path.join(this.workDirectory(id), 'manifest.json'), manifest);
    await rename(this.workDirectory(id), this.assetDirectory(id));
  }
}
