import { CHROME_USER_AGENT, extractHashtags, resolveRedirect } from './shared.js';
import type { ParsedMedia } from './types.js';

export function isBilibiliUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(host);
  } catch {
    return false;
  }
}

export async function parseBilibili(url: string, signal?: AbortSignal): Promise<ParsedMedia | null> {
  if (!isBilibiliUrl(url)) return null;

  let resolvedUrl = url;
  if (url.includes('b23.tv')) {
    resolvedUrl = await resolveRedirect(url, signal);
  }

  const bvMatch = /(BV[a-zA-Z0-9]{10})/i.exec(resolvedUrl);
  if (!bvMatch || !bvMatch[1]) return null;
  const bvid = bvMatch[1];

  const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const viewRes = await fetch(viewUrl, {
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Referer': 'https://www.bilibili.com/',
      'Accept': 'application/json',
    },
    signal: signal ?? AbortSignal.timeout(10000),
  });

  if (!viewRes.ok) return null;
  const viewJson = (await viewRes.json()) as any;
  if (viewJson?.code !== 0 || !viewJson?.data) return null;

  const data = viewJson.data;
  const title = typeof data.title === 'string' ? data.title : `????_${bvid}`;
  const desc = typeof data.desc === 'string' ? data.desc : '';
  const uploader = data.owner?.name || null;
  const durationSeconds = typeof data.duration === 'number' && data.duration > 0 ? data.duration : null;
  const coverUrl = typeof data.pic === 'string' ? (data.pic.startsWith('http') ? data.pic : `https:${data.pic}`) : null;
  const cid = data.cid;

  let videoUrl = '';
  let width: number | null = null;
  let height: number | null = null;

  if (cid) {
    const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=0&fnver=0&fourk=1`;
    const playRes = await fetch(playUrl, {
      headers: {
        'User-Agent': CHROME_USER_AGENT,
        'Referer': `https://www.bilibili.com/video/${bvid}`,
        'Accept': 'application/json',
      },
      signal: signal ?? AbortSignal.timeout(10000),
    });

    if (playRes.ok) {
      const playJson = (await playRes.json()) as any;
      if (playJson?.code === 0 && playJson?.data?.durl?.length > 0) {
        videoUrl = playJson.data.durl[0].url || '';
      }
    }
  }

  if (data.dimension) {
    if (typeof data.dimension.width === 'number') width = data.dimension.width;
    if (typeof data.dimension.height === 'number') height = data.dimension.height;
  }

  const tags = data.tag ? [data.tag] : extractHashtags(desc);

  return {
    id: bvid,
    platform: 'bilibili',
    title,
    description: desc,
    uploader,
    channel: uploader,
    durationSeconds,
    videoUrl,
    coverUrl,
    tags,
    width,
    height,
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Referer': `https://www.bilibili.com/video/${bvid}`,
    },
  };
}
