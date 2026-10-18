import { CHROME_USER_AGENT, extractHashtags, resolveRedirect } from './shared.js';
import type { ParsedMedia } from './types.js';

export function isKuaishouUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return ['kuaishou.com', 'www.kuaishou.com', 'v.kuaishou.com'].includes(host);
  } catch {
    return false;
  }
}

export async function parseKuaishou(url: string, signal?: AbortSignal): Promise<ParsedMedia | null> {
  if (!isKuaishouUrl(url)) return null;

  let resolvedUrl = url;
  if (url.includes('v.kuaishou.com')) {
    resolvedUrl = await resolveRedirect(url, signal);
  }

  const idMatch =
    /\/(?:short-video|video|photo)\/([A-Za-z0-9_-]+)/.exec(resolvedUrl) ||
    resolvedUrl.match(/photoId=([A-Za-z0-9_-]+)/);

  const photoId = idMatch?.[1];
  if (!photoId) return null;

  const graphqlPayload = {
    operationName: 'visionVideoDetail',
    variables: { photoId, page: 'detail' },
    query: `query visionVideoDetail($photoId: String, $page: String) {
      visionVideoDetail(photoId: $photoId, page: $page) {
        status
        photo {
          id
          caption
          duration
          photoUrl
          coverUrl
          userName
        }
      }
    }`,
  };

  const response = await fetch('https://www.kuaishou.com/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Referer': `https://www.kuaishou.com/short-video/${photoId}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(graphqlPayload),
    signal: signal ?? AbortSignal.timeout(10000),
  });

  if (!response.ok) return null;
  const json = (await response.json()) as any;
  const photo = json?.data?.visionVideoDetail?.photo;
  if (!photo) return null;

  const caption = typeof photo.caption === 'string' ? photo.caption : '';
  const author = photo.userName || null;
  let durationSeconds: number | null = null;
  if (typeof photo.duration === 'number' && photo.duration > 0) {
    durationSeconds = Math.max(1, Math.round(photo.duration / 1000));
  }

  const videoUrl = typeof photo.photoUrl === 'string' ? photo.photoUrl : '';
  if (!videoUrl) return null;

  const coverUrl = typeof photo.coverUrl === 'string' ? photo.coverUrl : null;

  return {
    id: photoId,
    platform: 'kuaishou',
    title: caption || `????_${photoId}`,
    description: caption,
    uploader: author,
    channel: author,
    durationSeconds,
    videoUrl,
    coverUrl,
    tags: extractHashtags(caption),
    width: null,
    height: null,
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Referer': 'https://www.kuaishou.com/',
    },
  };
}
