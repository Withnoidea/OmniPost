import { createWriteStream } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { FetcherError, throwIfAborted } from './errors.js';
import { atomicJson, describeFile, isRecord } from './store.js';
import { captureVideoFrame, normalizeMetadata, verifyVideo, type VideoProbeResult } from './downloader.js';
import type { ProcessRunner } from './process.js';
import type { AssetManifest, DownloadTask, ManualInput, MetadataManifest, PortableTools } from './types.js';

export function validateManual(input: unknown): ManualInput {
  if (!isRecord(input)) throw new FetcherError('INVALID_OPTIONS');
  for (const [key, max] of [['title', 500], ['description', 50000], ['author', 500]] as const) {
    if (typeof input[key] !== 'string' || input[key].length > max || input[key].includes('\0')) throw new FetcherError('INVALID_OPTIONS');
  }
  if (!(input.title as string).trim() || !Array.isArray(input.tags) || input.tags.length > 100 || input.tags.some(tag => typeof tag !== 'string' || tag.length > 100 || tag.includes('\0'))) throw new FetcherError('INVALID_OPTIONS');
  for (const key of ['videoPath', 'coverPath'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || !path.isAbsolute(input[key]) || input[key].length > 32768)) throw new FetcherError('INVALID_MEDIA');
  if (input.sourceUrl !== undefined && (typeof input.sourceUrl !== 'string' || input.sourceUrl.length > 2048)) throw new FetcherError('INVALID_URL');
  return structuredClone(input) as unknown as ManualInput;
}
/** Reject links, changing/incomplete downloads and non-files. Copy from the same open handle. */
async function copyLocal(source: string, target: string, extensions: string[], limit: number, signal: AbortSignal): Promise<void> {
  if (!extensions.includes(path.extname(source).toLowerCase())) throw new FetcherError('INVALID_MEDIA');
  const entry = await lstat(source);
  if (!entry.isFile() || entry.isSymbolicLink() || !entry.size || entry.size > limit) throw new FetcherError('INVALID_MEDIA');
  const handle = await open(source, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== entry.size || before.size > limit) throw new FetcherError('INVALID_MEDIA');
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new FetcherError('INVALID_MEDIA');
    throwIfAborted(signal);
  } finally { await handle.close(); }
}
export async function prepareManual(task: DownloadTask, input: ManualInput, directory: string, tools: PortableTools, runner: ProcessRunner, signal: AbortSignal): Promise<MetadataManifest | AssetManifest> {
  let cover = 'cover.png';
  let hasCover = false;
  if (input.coverPath) {
    cover = path.extname(input.coverPath).toLowerCase() === '.png' ? 'cover.png' : 'cover.jpg';
    await copyLocal(input.coverPath, path.join(directory, cover), ['.jpg', '.jpeg', '.png'], 16 * 1024 * 1024, signal);
    const bytes = await readFile(path.join(directory, cover));
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!(cover.endsWith('.png') ? png : jpg)) throw new FetcherError('INVALID_MEDIA');
    hasCover = true;
  }

  let probeResult: VideoProbeResult | undefined;
  if (input.videoPath) {
    await copyLocal(input.videoPath, path.join(directory, 'media.mp4'), ['.mp4'], Number.MAX_SAFE_INTEGER, signal);
    probeResult = await verifyVideo(directory, 'media.mp4', tools, runner, signal, true);
    if (!hasCover) {
      const captured = await captureVideoFrame(path.join(directory, 'media.mp4'), path.join(directory, 'cover.jpg'), tools, runner, signal, 1);
      if (captured) {
        cover = 'cover.jpg';
        hasCover = true;
      }
    }
  }

  if (!hasCover) {
    // Valid neutral placeholder, independent of ffmpeg; a cover is optional for manual recovery.
    await writeFile(path.join(directory, cover), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), { flag: 'wx', mode: 0o600 });
  }

  const raw: Record<string, unknown> = {
    id: task.id,
    title: input.title.trim(),
    description: input.description,
    tags: input.tags,
    uploader: input.author,
    channel: input.author,
    manual: true,
  };
  if (probeResult?.durationSeconds) raw.duration = probeResult.durationSeconds;
  if (probeResult?.width != null) raw.width = probeResult.width;
  if (probeResult?.height != null) raw.height = probeResult.height;

  const metadata = normalizeMetadata(raw, task);
  if (probeResult?.durationSeconds) metadata.durationSeconds = probeResult.durationSeconds;
  if (probeResult?.width != null) metadata.width = probeResult.width;
  if (probeResult?.height != null) metadata.height = probeResult.height;

  await atomicJson(path.join(directory, 'media.info.json'), raw);
  await atomicJson(path.join(directory, 'metadata.json'), metadata);
  const manifest: MetadataManifest = { schemaVersion: 1, taskId: task.id, sourceUrl: task.sourceUrl, createdAt: new Date().toISOString(), thumbnail: await describeFile(directory, cover, signal), metadataFile: 'metadata.json', rawMetadataFile: 'media.info.json', metadata };
  if (!input.videoPath) return manifest;
  return { ...manifest, video: await describeFile(directory, 'media.mp4', signal) };
}
