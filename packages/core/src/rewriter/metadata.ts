import { isRecord } from '../fetcher/store.js';
import { RewriterError } from './errors.js';
import type { SourceText } from './types.js';

const clip = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function extractSourceText(raw: unknown): SourceText {
  if (!isRecord(raw) || typeof raw.title !== 'string' || !raw.title.trim()) throw new RewriterError('INVALID_METADATA');
  const snippets: string[] = [clip(raw.transcript, 16_000)];
  let remaining = 16_000 - snippets[0]!.length;
  const languages = (value: unknown): string[] => isRecord(value) ? Object.keys(value).slice(0, 30).map((key) => key.slice(0, 40)) : [];
  for (const source of [raw.subtitles, raw.automatic_captions]) {
    if (!isRecord(source)) continue;
    for (const entries of Object.values(source).slice(0, 30)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries.slice(0, 100)) {
        if (!isRecord(entry) || remaining <= 0) continue;
        const text = clip(entry.text ?? entry.data, remaining);
        if (text) { snippets.push(text); remaining -= text.length; }
      }
    }
  }
  return {
    title: clip(raw.title, 500), description: clip(raw.description, 12_000),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 30).map((tag) => clip(tag, 80)).filter(Boolean) : [],
    language: clip(raw.language, 40) || null,
    subtitleLanguages: languages(raw.subtitles), automaticCaptionLanguages: languages(raw.automatic_captions),
    subtitleText: snippets.filter(Boolean).join('\n').slice(0, 16_000),
  };
}
