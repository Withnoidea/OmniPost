import { createWriteStream } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { FetcherError, throwIfAborted } from './errors.js';
import { atomicJson, describeFile } from './store.js';
import { normalizeMetadata, verifyVideo, type DownloaderOptions } from './downloader.js';
import type { ParsedMedia } from './parsers/types.js';
import type { AssetManifest, DownloadProgress, DownloadTask, MetadataManifest } from './types.js';
import type { ProcessRunner } from './process.js';

export async function fetchDirectMetadataIntoWorkspace(
  task: DownloadTask,
  parsed: ParsedMedia,
  directory: string,
  signal: AbortSignal,
): Promise<MetadataManifest> {
  throwIfAborted(signal);

  let coverFile = 'cover.png';
  let hasCover = false;

  if (parsed.coverUrl) {
    try {
      const coverRes = await fetch(parsed.coverUrl, {
        headers: {
          'User-Agent': parsed.headers?.['User-Agent'] || 'Mozilla/5.0',
          'Referer': parsed.headers?.['Referer'] || '',
        },
        signal,
      });
      if (coverRes.ok) {
        const buf = Buffer.from(await coverRes.arrayBuffer());
        if (buf.length > 0) {
          const isJpg = buf[0] === 255 && buf[1] === 216 && buf[2] === 255;
          const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          if (isJpg || isPng) {
            coverFile = isPng ? 'cover.png' : 'cover.jpg';
            await writeFile(path.join(directory, coverFile), buf);
            hasCover = true;
          }
        }
      }
    } catch {
      // Fallback below
    }
  }

  if (!hasCover) {
    await writeFile(
      path.join(directory, coverFile),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
      { flag: 'w', mode: 0o600 }
    );
  }

  const raw = {
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    uploader: parsed.uploader,
    channel: parsed.channel,
    duration: parsed.durationSeconds,
    tags: parsed.tags,
    categories: [],
    width: parsed.width ?? null,
    height: parsed.height ?? null,
    direct: true,
  };

  const metadata = normalizeMetadata(raw, task);
  if (parsed.width != null) metadata.width = parsed.width;
  if (parsed.height != null) metadata.height = parsed.height;

  await atomicJson(path.join(directory, 'media.info.json'), raw);
  await atomicJson(path.join(directory, 'metadata.json'), metadata);

  const thumbnailFile = await describeFile(directory, coverFile, signal);
  return {
    schemaVersion: 1,
    taskId: task.id,
    sourceUrl: task.sourceUrl,
    createdAt: new Date().toISOString(),
    thumbnail: thumbnailFile,
    metadataFile: 'metadata.json',
    rawMetadataFile: 'media.info.json',
    metadata,
  };
}

export async function downloadDirectIntoWorkspace(
  task: DownloadTask,
  parsed: ParsedMedia,
  directory: string,
  options: DownloaderOptions,
  runner: ProcessRunner,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<{ videoFile: string; manifest: AssetManifest }> {
  throwIfAborted(signal);

  // 1. Fetch metadata & cover
  const metaManifest = await fetchDirectMetadataIntoWorkspace(task, parsed, directory, signal);

  // 2. Stream video
  const videoHeaders = {
    'User-Agent': parsed.headers?.['User-Agent'] || 'Mozilla/5.0',
    'Referer': parsed.headers?.['Referer'] || '',
  };

  const response = await fetch(parsed.videoUrl, {
    headers: videoHeaders,
    signal,
  });

  if (!response.ok || !response.body) {
    throw new FetcherError('DOWNLOAD_FAILED', `?????????HTTP ???: ${response.status}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : undefined;
  const tempPath = path.join(directory, 'media.mp4.part');
  const finalPath = path.join(directory, 'media.mp4');

  let downloadedBytes = 0;
  let lastTime = Date.now();
  let lastBytes = 0;
  let currentSpeed = 0;

  const nodeReadable = Readable.fromWeb(response.body as any);
  nodeReadable.on('data', (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    const now = Date.now();
    const elapsedSec = (now - lastTime) / 1000;
    if (elapsedSec >= 0.5) {
      currentSpeed = (downloadedBytes - lastBytes) / elapsedSec;
      lastTime = now;
      lastBytes = downloadedBytes;
    }

    const progress: DownloadProgress = {
      phase: 'download',
      downloadedBytes,
    };
    if (totalBytes !== undefined && totalBytes > 0) {
      progress.totalBytes = totalBytes;
      progress.percent = Math.min(100, (downloadedBytes / totalBytes) * 100);
    }
    if (currentSpeed > 0) {
      progress.speedBytesPerSecond = currentSpeed;
    }
    if (totalBytes !== undefined && currentSpeed > 0) {
      progress.etaSeconds = Math.max(0, Math.round((totalBytes - downloadedBytes) / currentSpeed));
    }

    onProgress(progress);
  });

  const fileStream = createWriteStream(tempPath, { flags: 'w', mode: 0o600 });
  await pipeline(nodeReadable, fileStream, { signal });
  throwIfAborted(signal);

  await rename(tempPath, finalPath);

  // 3. Verify video using ffprobe
  const probeResult = await verifyVideo(directory, 'media.mp4', options.tools, runner, signal, true);

  // If probe returned better duration or dimensions, update metadata
  if (probeResult.durationSeconds && !metaManifest.metadata.durationSeconds) {
    metaManifest.metadata.durationSeconds = probeResult.durationSeconds;
  }
  if (probeResult.width) metaManifest.metadata.width = probeResult.width;
  if (probeResult.height) metaManifest.metadata.height = probeResult.height;

  await atomicJson(path.join(directory, 'metadata.json'), metaManifest.metadata);

  const videoFileDesc = await describeFile(directory, 'media.mp4', signal);
  return {
    videoFile: 'media.mp4',
    manifest: {
      ...metaManifest,
      video: videoFileDesc,
    },
  };
}
