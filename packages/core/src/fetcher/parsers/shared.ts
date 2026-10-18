export const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const DEFAULT_REFERER = 'https://www.google.com/';

export async function resolveRedirect(rawUrl: string, signal?: AbortSignal, customHeaders?: Record<string, string>): Promise<string> {
  const headers = {
    'User-Agent': CHROME_USER_AGENT,
    ...customHeaders,
  };
  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(10000),
    });
    return res.url || rawUrl;
  } catch {
    return rawUrl;
  }
}

export function extractHashtags(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/#([^\s#]+)/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map(m => m.slice(1).trim()).filter(Boolean)));
}
