import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
export class DesktopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new DesktopError('INVALID_INPUT', '输入为空或格式不正确。');
  return value.trim();
}
export function taskId(value: unknown): string {
  const id = text(value, 64);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new DesktopError('INVALID_TASK', '任务 ID 无效。');
  return id;
}
/** Both lexical and physical boundaries: a tampered manifest cannot escape its asset directory. */
export async function assetPath(directory: string, file: string): Promise<string> {
  if (!file || file !== path.basename(file) || file.includes(':') || file.includes('\\')) throw new DesktopError('INVALID_ASSET', '素材路径无效。');
  const root = await realpath(directory);
  const target = await realpath(path.join(root, file));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(target)).isFile()) throw new DesktopError('INVALID_ASSET', '素材文件不在任务目录中。');
  return target;
}
export function imageMime(buffer: Uint8Array): string | null {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (Buffer.from(buffer.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (Buffer.from(buffer.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(buffer.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  return null;
}
