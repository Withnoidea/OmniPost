import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { classifyDownloadError, FetcherError, throwIfAborted } from './errors.js';
import type { ProcessRunner } from './process.js';
import { atomicJson, describeFile, isRecord, readJson } from './store.js';
import type { AssetManifest, DownloadProgress, DownloadTask, MetadataManifest, PortableTools, VideoMetadata } from './types.js';

export const PROGRESS_PREFIX = '__OMNIPOST_PROGRESS__';
export const FILE_PREFIX = '__OMNIPOST_FILE__';
export const POSTPROCESS_PREFIX = '__OMNIPOST_POSTPROCESS__';
export interface DownloaderOptions {
  tools: PortableTools;
  socketTimeoutSeconds: number;
  retries: number;
}
function commonArguments(proxy: string, options: DownloaderOptions): string[] {
  return [
    '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-color', '--newline', '--no-simulate',
    '--no-overwrites', '--no-post-overwrites',
    '--socket-timeout', String(options.socketTimeoutSeconds),
    '--retries', String(options.retries), '--fragment-retries', String(options.retries), '--extractor-retries', String(options.retries),
    '--proxy', proxy, '--no-js-runtimes', '--js-runtimes', `node:${options.tools.node}`,
    '--match-filters', '!is_live & !is_upcoming',
    '--write-info-json', '--write-thumbnail',
    '--output', 'media.%(ext)s', '--output', 'thumbnail:cover.%(ext)s',
  ];
}
export function buildMetadataArguments(sourceUrl: string, proxy: string, options: DownloaderOptions): string[] {
  return [...commonArguments(proxy, options), '--skip-download', '--dump-json', '--', sourceUrl];
}
export function buildArguments(sourceUrl: string, proxy: string, options: DownloaderOptions): string[] {
  return [
    ...commonArguments(proxy, options), '--progress', '--no-keep-video',
    '--concurrent-fragments', '1', '--retry-sleep', 'linear=1:5:1',
    '--ffmpeg-location', path.dirname(options.tools.ffmpeg),
    '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    '--progress-template', `download:${PROGRESS_PREFIX}%(progress)j`,
    '--progress-template', `postprocess:${POSTPROCESS_PREFIX}%(progress)j`,
    '--print', `after_move:${FILE_PREFIX}%(filepath)j`,
    '--', sourceUrl,
  ];
}
/** Only info JSON and the original thumbnail are fetched; stdout JSON is intentionally not logged. */
export async function fetchMetadataIntoWorkspace(
  task: DownloadTask, proxy: string, directory: string, options: DownloaderOptions,
  runner: ProcessRunner, signal: AbortSignal,
): Promise<void> {
  const result = await runner({
    executable: options.tools.ytDlp, args: buildMetadataArguments(task.sourceUrl, proxy, options), cwd: directory, signal,
    onLine: () => {},
  });
  throwIfAborted(signal);
  if (result.exitCode !== 0) throw classifyDownloadError(result.stderr);
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function parseProgress(line: string): DownloadProgress | undefined {
  const phase = line.startsWith(PROGRESS_PREFIX) ? 'download' : line.startsWith(POSTPROCESS_PREFIX) ? 'postprocess' : undefined;
  if (!phase) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(phase === 'download' ? PROGRESS_PREFIX.length : POSTPROCESS_PREFIX.length));
    if (!isRecord(value)) return undefined;
    const downloadedBytes = finite(value.downloaded_bytes) ? value.downloaded_bytes : 0;
    const progress: DownloadProgress = { phase, downloadedBytes };
    const total = finite(value.total_bytes) ? value.total_bytes : value.total_bytes_estimate;
    if (finite(total) && total > 0) { progress.totalBytes = total; progress.percent = Math.min(100, downloadedBytes / total * 100); }
    if (finite(value.speed)) progress.speedBytesPerSecond = value.speed;
    if (finite(value.eta)) progress.etaSeconds = value.eta;
    return progress;
  } catch { return undefined; }
}
const textOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export function normalizeMetadata(raw: unknown, task: DownloadTask): VideoMetadata {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string' || !raw.title.trim()
    || raw.is_live === true || raw.live_status === 'is_live' || raw.live_status === 'is_upcoming') throw new FetcherError('INVALID_OUTPUT');
  return {
    id: raw.id, platform: task.platform, title: raw.title, description: textOrNull(raw.description) ?? '',
    uploader: textOrNull(raw.uploader), channel: textOrNull(raw.channel),
    durationSeconds: finite(raw.duration) ? raw.duration : null,
    language: textOrNull(raw.language), uploadDate: textOrNull(raw.upload_date),
    tags: texts(raw.tags), categories: texts(raw.categories),
    subtitleLanguages: isRecord(raw.subtitles) ? Object.keys(raw.subtitles) : [],
    automaticCaptionLanguages: isRecord(raw.automatic_captions) ? Object.keys(raw.automatic_captions) : [],
  };
}
export async function downloadIntoWorkspace(
  task: DownloadTask, proxy: string, directory: string, options: DownloaderOptions,
  runner: ProcessRunner, signal: AbortSignal, onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  let output: string | undefined;
  const result = await runner({
    executable: options.tools.ytDlp, args: buildArguments(task.sourceUrl, proxy, options), cwd: directory, signal,
    onLine: (line) => {
      const progress = parseProgress(line);
      if (progress) onProgress(progress);
      if (line.startsWith(FILE_PREFIX)) {
        try { const value: unknown = JSON.parse(line.slice(FILE_PREFIX.length)); if (typeof value === 'string') output = value; } catch { /* not a final-path message */ }
      }
    },
  });
  throwIfAborted(signal);
  if (result.exitCode !== 0) throw classifyDownloadError(result.stderr);
  if (!output) throw new FetcherError('INVALID_OUTPUT');
  const full = path.resolve(directory, output);
  try {
    if (path.dirname(full) !== directory || path.basename(full) !== 'media.mp4' || await realpath(full) !== path.join(await realpath(directory), 'media.mp4')) throw new Error();
  } catch { throw new FetcherError('INVALID_OUTPUT'); }
  return path.basename(full);
}
export async function verifyVideo(directory: string, video: string, tools: PortableTools, runner: ProcessRunner, signal: AbortSignal, requireMp4 = false): Promise<void> {
  let stdout = '';
  const result = await runner({
    executable: tools.ffprobe,
    args: ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', path.join(directory, video)],
    cwd: directory, signal,
    onLine: (line) => { if (stdout.length < 1024 * 1024) stdout += line; },
  });
  throwIfAborted(signal);
  try {
    const data: unknown = JSON.parse(stdout);
    if (result.exitCode !== 0 || !isRecord(data) || !Array.isArray(data.streams)
      || !data.streams.some((stream: unknown) => isRecord(stream) && stream.codec_type === 'video')
      || !isRecord(data.format) || !Number.isFinite(Number(data.format.duration)) || Number(data.format.duration) <= 0
      || (requireMp4 && (typeof data.format.format_name !== 'string' || !data.format.format_name.split(',').includes('mp4')))) throw new Error();
  } catch { throw new FetcherError('INVALID_OUTPUT'); }
}
export async function prepareMetadataManifest(task: DownloadTask, directory: string, signal: AbortSignal): Promise<MetadataManifest> {
  throwIfAborted(signal);
  try {
    const names = await readdir(directory);
    if (names.some((name) => name.endsWith('.part') || name.endsWith('.ytdl'))) throw new FetcherError('INVALID_OUTPUT');
    // Avoid loading an unexpectedly large metadata payload into the desktop process.
    if ((await stat(path.join(directory, 'media.info.json'))).size > 32 * 1024 * 1024) throw new FetcherError('INVALID_OUTPUT');
    const metadata = normalizeMetadata(await readJson(path.join(directory, 'media.info.json')), task);
    const covers = names.filter((name) => /^cover\.(?:jpg|jpeg|png|webp|avif|heic)$/i.test(name));
    if (covers.length !== 1) throw new FetcherError('INVALID_OUTPUT');
    const thumbnailFile = await describeFile(directory, covers[0]!, signal);
    throwIfAborted(signal);
    await atomicJson(path.join(directory, 'metadata.json'), metadata);
    return {
      schemaVersion: 1, taskId: task.id, sourceUrl: task.sourceUrl, createdAt: new Date().toISOString(),
      thumbnail: thumbnailFile, metadataFile: 'metadata.json', rawMetadataFile: 'media.info.json', metadata,
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof FetcherError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO'].includes(code ?? '')) throw new FetcherError('PERSISTENCE_ERROR');
    throw new FetcherError('INVALID_OUTPUT');
  }
}

export async function prepareManifest(task: DownloadTask, directory: string, video: string, signal: AbortSignal): Promise<AssetManifest> {
  const metadata = await prepareMetadataManifest(task, directory, signal);
  const videoFile = await describeFile(directory, video, signal);
  return { ...metadata, video: videoFile };
}
