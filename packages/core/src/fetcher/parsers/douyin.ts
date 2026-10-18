import { CHROME_USER_AGENT, extractHashtags, resolveRedirect } from './shared.js';
import type { ParsedMedia } from './types.js';

export function isDouyinUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return ['v.douyin.com', 'douyin.com', 'www.douyin.com', 'iesdouyin.com'].includes(host);
  } catch {
    return false;
  }
}

export async function parseDouyin(url: string, signal?: AbortSignal): Promise<ParsedMedia | null> {
  if (!isDouyinUrl(url)) return null;

  let resolvedUrl = url;
  if (url.includes('v.douyin.com')) {
    resolvedUrl = await resolveRedirect(url, signal);
  }

  const idMatch =
    /\/(?:video|note|share\/video)\/(\d+)/.exec(resolvedUrl) ||
    /[?&]modal_id=(\d+)/.exec(resolvedUrl) ||
    resolvedUrl.match(/\d{18,20}/);

  if (!idMatch) return null;
  const awemeId = idMatch[1] ?? idMatch[0];

  const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383`;
  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Referer': 'https://www.douyin.com/',
      'Accept': 'application/json',
    },
    signal: signal ?? AbortSignal.timeout(10000),
  });

  if (!response.ok) return null;
  const json = (await response.json()) as any;
  const detail = json?.aweme_detail;
  if (!detail) return null;

  const desc = typeof detail.desc === 'string' ? detail.desc : '';
  const authorName = detail.author?.nickname || detail.author?.unique_id || null;
  
  // Duration in Douyin detail is in milliseconds
  let durationSeconds: number | null = null;
  if (typeof detail.duration === 'number' && detail.duration > 0) {
    durationSeconds = Math.max(1, Math.round(detail.duration / 1000));
  } else if (typeof detail.video?.duration === 'number' && detail.video.duration > 0) {
    durationSeconds = Math.max(1, Math.round(detail.video.duration / 1000));
  }

  // Cover image
  const coverUrlList = detail.video?.cover?.url_list || detail.video?.origin_cover?.url_list || [];
  const coverUrl = coverUrlList.length > 0 ? coverUrlList[0] : null;

  // Video download url: replace playwm with play for watermark-free video
  const playUrls: string[] = detail.video?.play_addr?.url_list || [];
  let videoUrl = '';
  for (const rawPlayUrl of playUrls) {
    if (typeof rawPlayUrl === 'string' && rawPlayUrl) {
      videoUrl = rawPlayUrl.replace('/playwm/', '/play/');
      break;
    }
  }

  if (!videoUrl) return null;

  const width = typeof detail.video?.width === 'number' ? detail.video.width : null;
  const height = typeof detail.video?.height === 'number' ? detail.video.height : null;

  return {
    id: awemeId,
    platform: 'douyin',
    title: desc || `????_${awemeId}`,
    description: desc,
    uploader: authorName,
    channel: authorName,
    durationSeconds,
    videoUrl,
    coverUrl,
    tags: extractHashtags(desc),
    width,
    height,
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Referer': 'https://www.douyin.com/',
    },
  };
}
