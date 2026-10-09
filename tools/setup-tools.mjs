import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../resources/bin/', import.meta.url));
const lock = JSON.parse((await readFile(new URL('../resources/tools.lock.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
if (`${process.platform}-${process.arch}` !== lock.target) throw new Error('The supplied tool lock currently supports Windows x64 only.');
const target = path.join(root, lock.target);
try { await access(target); console.error('Portable tools already exist. Run npm run verify:tools; do not overwrite running executables.'); process.exit(1); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(root, { recursive: true });
const staging = path.join(root, `.install-${randomUUID()}`);
await mkdir(staging);

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(item, destination) {
  console.log(`Downloading ${path.basename(destination)} (pinned SHA-256)`);
  const response = await fetch(item.url, { signal: AbortSignal.timeout(300_000), headers: { 'User-Agent': 'OmniPost-build/0.1' } });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 200 * 1024 * 1024 ? new Error('Download exceeds size limit') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destination, { flags: 'wx' }));
  if (await hashFile(destination) !== item.sha256) throw new Error(`Checksum mismatch: ${path.basename(destination)}`);
}
async function run(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Tool exited ${code}`)));
  });
}
async function removeStaging() {
  const resolved = path.resolve(staging);
  if (path.dirname(resolved) !== path.resolve(root) || !path.basename(resolved).startsWith('.install-')) throw new Error('Unsafe cleanup path');
  await rm(resolved, { recursive: true, force: true });
}
try {
  await download(lock.ytDlp, path.join(staging, 'yt-dlp.exe'));
  await download(lock.node, path.join(staging, 'node.exe'));
  const archive = path.join(staging, 'ffmpeg.zip');
  await download(lock.ffmpeg, archive);
  const extracted = path.join(staging, 'ffmpeg-distribution');
  await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:OMNIPOST_ARCHIVE -DestinationPath $env:OMNIPOST_EXTRACT',
  ], { env: { ...process.env, OMNIPOST_ARCHIVE: archive, OMNIPOST_EXTRACT: extracted } });
  for (const file of ['ffmpeg.exe', 'ffprobe.exe']) await cp(path.join(extracted, lock.ffmpeg.directory, 'bin', file), path.join(staging, file));
  // Keep upstream FFmpeg distribution (license/docs and the exact verified archive) for release compliance.
  await cp(new URL('../resources/THIRD_PARTY_NOTICES.md', import.meta.url), path.join(staging, 'THIRD_PARTY_NOTICES.md'));
  const manifest = { schemaVersion: 1, target: lock.target, lock, files: {} };
  for (const file of ['yt-dlp.exe', 'node.exe', 'ffmpeg.exe', 'ffprobe.exe']) manifest.files[file] = await hashFile(path.join(staging, file));
  await writeFile(path.join(staging, 'tools.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await run(path.join(staging, 'yt-dlp.exe'), ['--ignore-config', '--version']);
  await run(path.join(staging, 'node.exe'), ['--version']);
  await run(path.join(staging, 'ffmpeg.exe'), ['-hide_banner', '-version']);
  await run(path.join(staging, 'ffprobe.exe'), ['-hide_banner', '-version']);
  await rename(staging, target);
  console.log(`Portable tool bundle ready: ${target}`);
} catch (error) {
  await removeStaging();
  console.error(error instanceof Error ? error.message : 'Tool preparation failed');
  process.exitCode = 1;
}
