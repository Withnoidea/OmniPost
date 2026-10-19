import { CHROME_USER_AGENT, resolveRedirect } from './parsers/shared.js';
import { tryDirectParse, type ParsedMedia } from './parsers/index.js';

export interface ExtractedShareUrl {
  url: string;
  platform: 'douyin' | 'kuaishou' | 'bilibili' | 'xiaohongshu' | 'wechat' | 'unknown';
  originalText?: string;
}

const INVISIBLE_CHARS = [
  '\u0000', '\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007', '\u0008',
  '\u000B', '\u000C', '\u000E', '\u000F', '\u0010', '\u0011', '\u0012', '\u0013', '\u0014',
  '\u0015', '\u0016', '\u0017', '\u0018', '\u0019', '\u001A', '\u001B', '\u001C', '\u001D',
  '\u001E', '\u001F', '\u007F', '\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'
];
const CJK_SEPARATOR_RE = /[，。！？；、…《》【】「」『』〔〕〈〉]/g;
const SCHEME_OR_URL_RE = /(?:https?:\/\/|www\.)[^\s<>{}\[\]"'`|\\]+/gi;

export function cleanShareText(raw: string): string {
  if (!raw) return '';
  let cleaned = raw.replace(/\\\//g, '/');
  for (const ch of INVISIBLE_CHARS) {
    cleaned = cleaned.replaceAll(ch, '');
  }
  return cleaned.replace(CJK_SEPARATOR_RE, ' ').trim();
}

export function extractShareUrls(raw: string): ExtractedShareUrl[] {
  const cleaned = cleanShareText(raw);
  const matches = cleaned.match(SCHEME_OR_URL_RE);
  if (!matches) return [];

  const results: ExtractedShareUrl[] = [];
  const seen = new Set<string>();

  for (let match of matches) {
    if (!match.startsWith('http://') && !match.startsWith('https://')) {
      match = 'https://' + match;
    }
    match = match.replace(/[.,!?:;，。、\s]+$/, '');
    if (seen.has(match)) continue;
    seen.add(match);

    let platform: ExtractedShareUrl['platform'] = 'unknown';
    const lower = match.toLowerCase();
    if (lower.includes('douyin.com') || lower.includes('iesdouyin.com')) {
      platform = 'douyin';
    } else if (lower.includes('kuaishou.com') || lower.includes('kwai.com') || lower.includes('gifshow.com')) {
      platform = 'kuaishou';
    } else if (lower.includes('bilibili.com') || lower.includes('b23.tv')) {
      platform = 'bilibili';
    } else if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com')) {
      platform = 'xiaohongshu';
    } else if (lower.includes('weixin.qq.com') || lower.includes('qq.com')) {
      platform = 'wechat';
    }

    results.push({ url: match, platform, originalText: raw });
  }
  return results;
}

export async function extractMediaFromShare(
  rawTextOrUrl: string,
  signal?: AbortSignal
): Promise<ParsedMedia | null> {
  const extracted = extractShareUrls(rawTextOrUrl);
  const targetUrl = extracted.length > 0 ? extracted[0].url : rawTextOrUrl.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return null;
  }
  const resolved = await resolveRedirect(targetUrl, signal);
  return await tryDirectParse(resolved, signal);
}
