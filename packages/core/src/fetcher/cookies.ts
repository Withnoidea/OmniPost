import { lstat, mkdir, open, rename, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Platform } from './types.js';
import { FetcherError } from './errors.js';
export interface BrowserCookie { domain: string; path: string; name: string; value: string; secure: boolean; httpOnly?: boolean; expirationDate?: number }
export function cookieDomainAllowed(platform: Platform, domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  const roots = platform === 'youtube' ? ['youtube.com', 'google.com'] : platform === 'tiktok' ? ['tiktok.com', 'tiktokv.com'] : [];
  return roots.some(root => host === root || host.endsWith('.' + root));
}
export function serializeCookies(platform: Platform, cookies: BrowserCookie[], now = Date.now() / 1000): string {
  const rows = cookies.filter(c => cookieDomainAllowed(platform, c.domain) && (!c.expirationDate || c.expirationDate > now)).map(c => {
    if ([c.domain, c.path, c.name, c.value].some(value => typeof value !== 'string' || /[\r\n\t\0]/.test(value)) || !c.name || !c.path.startsWith('/')) throw new FetcherError('INVALID_OPTIONS');
    return [(c.httpOnly ? '#HttpOnly_' : '') + c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE', c.expirationDate ? Math.floor(c.expirationDate) : 0, c.name, c.value].join('\t');
  });
  if (!rows.length || rows.length > 3000) throw new FetcherError('AUTH_REQUIRED');
  const result = '# Netscape HTTP Cookie File\n# OmniPost: local credentials; do not share.\n' + rows.join('\n') + '\n';
  if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new FetcherError('INVALID_OPTIONS');
  return result;
}
export class CookieStore {
  constructor(private readonly root: string) {}
  private file(platform: Platform): string {
    if (platform !== 'youtube' && platform !== 'tiktok') throw new FetcherError('INVALID_OPTIONS');
    return path.join(this.root, 'cookies', `${platform}.txt`);
  }
  async get(platform: Platform): Promise<string | undefined> {
    if (platform === 'local') return undefined;
    const file = this.file(platform);
    try { if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new FetcherError('PERSISTENCE_ERROR'); const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new FetcherError('PERSISTENCE_ERROR'); return file; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  /** yt-dlp may rewrite its jar. Each worker gets an isolated copy, never committed as an asset. */
  async snapshot(platform: Platform): Promise<{ file: string; dispose: () => Promise<void> } | undefined> {
    const source = await this.get(platform); if (!source) return undefined;
    const file = path.join(path.dirname(source), `request-${randomUUID()}.txt`);
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(await readFile(source)); await handle.sync(); } finally { await handle.close(); }
    return { file, dispose: async () => { await unlink(file).catch(() => {}); } };
  }
  async save(platform: Platform, cookies: BrowserCookie[]): Promise<void> {
    const content = serializeCookies(platform, cookies);
    const file = this.file(platform); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new FetcherError('PERSISTENCE_ERROR');
    const temporary = file + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  }
}
