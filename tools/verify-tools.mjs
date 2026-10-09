import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL(`../resources/bin/${process.platform}-${process.arch}/`, import.meta.url));
try {
  const manifest = JSON.parse(await readFile(path.join(directory, 'tools.manifest.json'), 'utf8'));
  const lock = JSON.parse((await readFile(new URL('../resources/tools.lock.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
  if (JSON.stringify(manifest.lock) !== JSON.stringify(lock)) throw new Error('Installed tools differ from tools.lock.json');
  for (const name of ['yt-dlp.exe', 'node.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
    const file = path.join(directory, name);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.files[name]) throw new Error(`Integrity failure: ${name}`);
    const args = name === 'yt-dlp.exe' ? ['--ignore-config', '--version'] : name === 'node.exe' ? ['--version'] : ['-hide_banner', '-version'];
    const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, shell: false });
    if (result.error || result.status !== 0) throw new Error(`Cannot execute ${name}`);
    console.log(`${name}: SHA-256 OK; ${result.stdout.split(/\r?\n/)[0]}`);
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Tool verification failed'); process.exitCode = 1; }
