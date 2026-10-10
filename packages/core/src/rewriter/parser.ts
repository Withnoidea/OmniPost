import { isRecord } from '../fetcher/store.js';
import { RewriterError } from './errors.js';
import type { LocalizedCopy, TargetPlatform } from './types.js';

const invalid = (): never => { throw new RewriterError('INVALID_RESPONSE'); };
function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) return invalid();
  return value.trim();
}
export function validateCopy(value: unknown, platform: TargetPlatform): LocalizedCopy {
  if (!isRecord(value)) return invalid();
  const title = field(value.title, platform === 'bilibili' ? 80 : platform === 'xiaohongshu' ? 40 : 30);
  let body = field(value.body, 4000);
  if (!Array.isArray(value.tags) || value.tags.length > 10) return invalid();
  const tags = [...new Set(value.tags.map((tag: unknown) => {
    const normalized = field(tag, 32).replace(/^#+/u, '');
    if (!normalized || [...normalized].length > 30 || /[\s#]/u.test(normalized)) return invalid();
    return normalized;
  }))];
  if (tags.length < 1) return invalid();
  if (platform === 'xiaohongshu') {
    if (tags.length < 3 || tags.length > 5 || title.split('｜').length !== 2 || title.split('｜').some((part) => !part.trim())) return invalid();
    // Canonical suffix: tolerate models already appending their tags, without duplicating them.
    body = body.replace(/(?:^|\s)#[^\s#]+(?:\s+#[^\s#]+)*\s*$/u, '').trim();
    if (!body) return invalid();
    body += '\n\n' + tags.map((tag) => `#${tag}`).join(' ');
    if ([...body].length > 4000) return invalid();
  }
  const copy: LocalizedCopy = { title, body, tags };
  if (platform === 'bilibili') copy.category = field(value.category, 80);
  if (platform === 'douyin' || platform === 'kuaishou') copy.hook = field(value.hook, 80);
  return copy;
}
/** Accept a single JSON object, optionally fenced or surrounded by prose; never eval or guess repairs. */
export function parseRewriteOutput(text: string, platform: TargetPlatform): LocalizedCopy {
  if (text.length > 128_000) return invalid();
  let content = text.replace(/^\uFEFF/u, '').trim();
  const fences = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fences.length > 1) return invalid();
  if (fences.length === 1) content = fences[0]![1]!.trim();
  let value: unknown;
  try { value = JSON.parse(content); }
  catch {
    let depth = 0; let start = -1; let quoted = false; let escaped = false;
    const objects: string[] = [];
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (depth === 0) {
        if (char === '{') { start = i; depth = 1; }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) objects.push(content.slice(start, i + 1));
    }
    if (depth !== 0 || objects.length !== 1) return invalid();
    try { value = JSON.parse(objects[0]!); } catch { return invalid(); }
  }
  return validateCopy(value, platform);
}
