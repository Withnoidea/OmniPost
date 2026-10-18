import { isBilibiliUrl, parseBilibili } from './bilibili.js';
import { isDouyinUrl, parseDouyin } from './douyin.js';
import { isKuaishouUrl, parseKuaishou } from './kuaishou.js';
import type { ParsedMedia } from './types.js';

export * from './types.js';
export * from './shared.js';
export * from './douyin.js';
export * from './bilibili.js';
export * from './kuaishou.js';

export function isDirectSupported(url: string): boolean {
  return isDouyinUrl(url) || isBilibiliUrl(url) || isKuaishouUrl(url);
}

export async function tryDirectParse(url: string, signal?: AbortSignal): Promise<ParsedMedia | null> {
  try {
    if (isDouyinUrl(url)) {
      return await parseDouyin(url, signal);
    }
    if (isBilibiliUrl(url)) {
      return await parseBilibili(url, signal);
    }
    if (isKuaishouUrl(url)) {
      return await parseKuaishou(url, signal);
    }
  } catch {
    return null;
  }
  return null;
}
