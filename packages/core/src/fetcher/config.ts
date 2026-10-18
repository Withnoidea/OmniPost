import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { FetcherError } from './errors.js';
import type { Platform, PortableTools } from './types.js';

export function normalizeSource(input: string): { url: string; platform: Platform } {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\u007f]/u.test(input)) throw new FetcherError('INVALID_URL');
  let url: URL;
  try { url = new URL(input); } catch { throw new FetcherError('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new FetcherError('INVALID_URL');
  const host = url.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch'
      ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new FetcherError('INVALID_URL');
    return { url: `https://www.youtube.com/watch?v=${id}`, platform: 'youtube' };
  }
  if (['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(host) && /^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)) {
    return { url: `https://www.tiktok.com${url.pathname.replace(/\/$/, '')}`, platform: 'tiktok' };
  }
  if (['vm.tiktok.com', 'vt.tiktok.com'].includes(host) && /^\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    return { url: `https://${host}${url.pathname}`, platform: 'tiktok' };
  }
  if (host === 'www.tiktok.com' && /^\/t\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    return { url: `https://${host}${url.pathname}`, platform: 'tiktok' };
  }
  if (['v.douyin.com', 'douyin.com', 'www.douyin.com', 'iesdouyin.com'].includes(host)) {
    if (host === 'v.douyin.com') {
      if (!/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new FetcherError('INVALID_URL');
      return { url: `https://v.douyin.com${url.pathname}`, platform: 'douyin' };
    }
    const id = /^\/(?:video|note|share\/video)\/(\d+)\/?$/.exec(url.pathname)?.[1] || url.searchParams.get('modal_id');
    if (!id || !/^\d{15,25}$/.test(id)) throw new FetcherError('INVALID_URL');
    return { url: `https://www.douyin.com/video/${id}`, platform: 'douyin' };
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(host)) {
    if (host === 'b23.tv') {
      if (!/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new FetcherError('INVALID_URL');
      return { url: `https://b23.tv${url.pathname}`, platform: 'bilibili' };
    }
    const match = /^\/video\/(BV[a-zA-Z0-9]{10}|av\d+)\/?$/i.exec(url.pathname);
    if (!match) throw new FetcherError('INVALID_URL');
    return { url: `https://www.bilibili.com/video/${match[1]}`, platform: 'bilibili' };
  }
  if (['kuaishou.com', 'www.kuaishou.com', 'v.kuaishou.com'].includes(host)) {
    if (host === 'v.kuaishou.com') {
      if (!/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new FetcherError('INVALID_URL');
      return { url: `https://v.kuaishou.com${url.pathname}`, platform: 'kuaishou' };
    }
    const id = /^\/(?:short-video|video|photo)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new FetcherError('INVALID_URL');
    return { url: `https://www.kuaishou.com/short-video/${id}`, platform: 'kuaishou' };
  }
  throw new FetcherError('INVALID_URL');
}

export function normalizeProxy(input?: string): string {
  if (input === undefined || input === '') return '';
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\u007f]/u.test(input)) throw new FetcherError('INVALID_PROXY');
  try {
    const url = new URL(input);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) throw new Error();
    // WHATWG URL does not validate ports on non-special protocols (SOCKS).
    if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error();
    decodeURIComponent(url.username); decodeURIComponent(url.password);
    return url.href;
  } catch { throw new FetcherError('INVALID_PROXY'); }
}

export function integerOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new FetcherError('INVALID_OPTIONS');
  return value;
}

export function resolvePortableTools(resourcesDirectory: string, platform = process.platform, arch = process.arch): PortableTools {
  const directory = path.resolve(resourcesDirectory, 'bin', `${platform}-${arch}`);
  const suffix = platform === 'win32' ? '.exe' : '';
  return {
    ytDlp: path.join(directory, `yt-dlp${suffix}`),
    ffmpeg: path.join(directory, `ffmpeg${suffix}`),
    ffprobe: path.join(directory, `ffprobe${suffix}`),
    node: path.join(directory, `node${suffix}`),
  };
}
export async function validateTools(tools: PortableTools, operation: 'download' | 'metadata' | 'attachment' = 'download'): Promise<void> {
  try {
    const files = operation === 'metadata' ? [tools.ytDlp, tools.node] : operation === 'attachment' ? [tools.ffprobe] : [tools.ytDlp, tools.ffmpeg, tools.ffprobe, tools.node];
    for (const file of files) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error();
      if (!(await stat(file)).isFile()) throw new Error();
      await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    }
    if (operation === 'download' && path.dirname(tools.ffmpeg) !== path.dirname(tools.ffprobe)) throw new Error();
  } catch { throw new FetcherError('TOOL_NOT_FOUND'); }
}
