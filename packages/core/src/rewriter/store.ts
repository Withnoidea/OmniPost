import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, isRecord, TASK_ID } from '../fetcher/store.js';
import { RewriterError, storageError } from './errors.js';
import { extractSourceText } from './metadata.js';
import { validateCopy } from './parser.js';
import { TARGET_PLATFORMS, type RewrittenDocument, type SourceText, type TargetPlatform } from './types.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function readBounded(file: string, limit: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) throw new Error();
  const data = await readFile(file);
  if (data.length > limit) throw new Error();
  return data;
}
export class RewriteStore {
  readonly root: string;
  constructor(root: string) {
    if (typeof root !== 'string' || !root.trim()) throw new RewriterError('INVALID_OPTIONS');
    this.root = path.resolve(root);
  }
  async directory(id: string): Promise<string> {
    if (!TASK_ID.test(id)) throw new RewriterError('INVALID_OPTIONS');
    const directory = path.join(this.root, 'assets', id);
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || await realpath(directory) !== path.join(await realpath(this.root), 'assets', id)) throw new RewriterError('ASSET_NOT_READY');
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RewriterError('TASK_NOT_FOUND');
      throw storageError(error);
    }
  }
  /** Per-task marker lock; independent of Fetcher's data-root ownership. Dead PID markers are retained. */
  async lock(directory: string, namespace: 'rewrite' | 'process' = 'rewrite'): Promise<() => Promise<void>> {
    const locks = path.join(directory, `.${namespace}-locks`);
    let marker: string | undefined;
    try {
      await mkdir(locks, { recursive: true, mode: 0o700 });
      if ((await lstat(locks)).isSymbolicLink()) throw new RewriterError('ASSET_NOT_READY');
      marker = path.join(locks, `${process.pid}-${randomUUID()}.lock`);
      const handle = await open(marker, 'wx', 0o600); await handle.close();
      for (const name of await readdir(locks)) {
        const match = /^(\d+)-[a-f0-9-]+\.lock$/.exec(name);
        if (match && path.join(locks, name) !== marker && alive(Number(match[1]))) throw new RewriterError('STORE_LOCKED');
      }
      const ownMarker = marker;
      return async () => { try { await unlink(ownMarker); } catch (error) { throw storageError(error); } };
    } catch (error) {
      if (marker) await unlink(marker).catch(() => {});
      throw storageError(error);
    }
  }
  async source(directory: string, id: string): Promise<{ text: SourceText; sha256: string }> {
    let committed = false;
    for (const file of ['metadata.manifest.json', 'manifest.json']) {
      try {
        const value: unknown = JSON.parse((await readBounded(path.join(directory, file), 2 * 1024 * 1024)).toString('utf8'));
        if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== id || value.rawMetadataFile !== 'media.info.json') throw new RewriterError('ASSET_NOT_READY');
        committed = true; break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new RewriterError('ASSET_NOT_READY');
      }
    }
    if (!committed) throw new RewriterError('ASSET_NOT_READY');
    try {
      const raw = await readBounded(path.join(directory, 'media.info.json'), 32 * 1024 * 1024);
      return { text: extractSourceText(JSON.parse(raw.toString('utf8'))), sha256: createHash('sha256').update(raw).digest('hex') };
    } catch { throw new RewriterError('INVALID_METADATA'); }
  }
  async load(directory: string, id: string, sourceHash: string): Promise<RewrittenDocument | undefined> {
    try {
      const value: unknown = JSON.parse((await readBounded(path.join(directory, 'rewritten.json'), 1024 * 1024)).toString('utf8'));
      if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== id || typeof value.updatedAt !== 'string'
        || !isRecord(value.source) || value.source.file !== 'media.info.json' || typeof value.source.sha256 !== 'string'
        || !isRecord(value.platforms)) throw new Error();
      for (const [platform, entry] of Object.entries(value.platforms)) {
        if (!TARGET_PLATFORMS.includes(platform as TargetPlatform) || !isRecord(entry) || entry.platform !== platform
          || typeof entry.model !== 'string' || !entry.model || typeof entry.generatedAt !== 'string') throw new Error();
        validateCopy(entry, platform as TargetPlatform);
      }
      if (value.source.sha256 !== sourceHash) throw new RewriterError('SOURCE_CHANGED');
      return value as unknown as RewrittenDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof RewriterError && error.code === 'SOURCE_CHANGED') throw error;
      throw new RewriterError('CORRUPT_OUTPUT');
    }
  }
  async save(directory: string, document: RewrittenDocument): Promise<void> {
    try {
      const current = await this.source(directory, document.taskId);
      if (current.sha256 !== document.source.sha256) throw new RewriterError('SOURCE_CHANGED');
      await atomicJson(path.join(directory, 'rewritten.json'), document);
    } catch (error) { throw storageError(error); }
  }
}
