import path from 'node:path';
import { atomicJson, readJson, isRecord } from '../fetcher/store.js';
import type { TargetPlatform } from '../rewriter/types.js';

export interface PublicationMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  updatedAt: string;
}

export interface PublicationRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  cover?: string | null;
  platform: TargetPlatform;
  publishedAt: string;
  title: string;
  status: 'published' | 'draft';
  url?: string | undefined;
  metrics: PublicationMetrics;
}

export interface CreatorPulseMetrics {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  averageEngagementRate: number;
  totalPublished: number;
  topPlatform: TargetPlatform | null;
  platformBreakdown: Record<
    TargetPlatform,
    {
      publishedCount: number;
      views: number;
      likes: number;
      comments: number;
      shares: number;
    }
  >;
  publications: PublicationRecord[];
}

export function publicationsFile(dataDirectory: string): string {
  return path.join(dataDirectory, 'publications.json');
}

export async function loadPublications(dataDirectory: string): Promise<PublicationRecord[]> {
  const file = publicationsFile(dataDirectory);
  try {
    const data = await readJson(file);
    if (Array.isArray(data)) {
      return data.filter(item => isRecord(item) && typeof item.id === 'string' && typeof item.platform === 'string') as PublicationRecord[];
    }
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

export function calculateCreatorPulse(publications: PublicationRecord[]): CreatorPulseMetrics {
  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalShares = 0;

  const platforms: TargetPlatform[] = ['xiaohongshu', 'bilibili', 'douyin', 'kuaishou'];
  const breakdown: Record<TargetPlatform, { publishedCount: number; views: number; likes: number; comments: number; shares: number }> = {
    xiaohongshu: { publishedCount: 0, views: 0, likes: 0, comments: 0, shares: 0 },
    bilibili: { publishedCount: 0, views: 0, likes: 0, comments: 0, shares: 0 },
    douyin: { publishedCount: 0, views: 0, likes: 0, comments: 0, shares: 0 },
    kuaishou: { publishedCount: 0, views: 0, likes: 0, comments: 0, shares: 0 },
  };

  for (const pub of publications) {
    const m = pub.metrics || { views: 0, likes: 0, comments: 0, shares: 0 };
    totalViews += m.views || 0;
    totalLikes += m.likes || 0;
    totalComments += m.comments || 0;
    totalShares += m.shares || 0;

    const b = breakdown[pub.platform];
    if (b) {
      b.publishedCount += 1;
      b.views += m.views || 0;
      b.likes += m.likes || 0;
      b.comments += m.comments || 0;
      b.shares += m.shares || 0;
    }
  }

  let topPlatform: TargetPlatform | null = null;
  let maxViews = -1;
  for (const p of platforms) {
    if (breakdown[p].views > maxViews && breakdown[p].publishedCount > 0) {
      maxViews = breakdown[p].views;
      topPlatform = p;
    }
  }
  if (!topPlatform) {
    for (const p of platforms) {
      if (breakdown[p].publishedCount > 0) {
        topPlatform = p;
        break;
      }
    }
  }

  const totalInteractions = totalLikes + totalComments + totalShares;
  const averageEngagementRate = totalViews > 0 ? Number(((totalInteractions / totalViews) * 100).toFixed(1)) : 0;

  return {
    totalViews,
    totalLikes,
    totalComments,
    totalShares,
    averageEngagementRate,
    totalPublished: publications.length,
    topPlatform,
    platformBreakdown: breakdown,
    publications: [...publications].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
  };
}

export async function savePublication(
  dataDirectory: string,
  input: Omit<PublicationRecord, 'id' | 'metrics'> & { id?: string; metrics?: Partial<PublicationMetrics> }
): Promise<PublicationRecord> {
  const existing = await loadPublications(dataDirectory);
  const now = new Date().toISOString();
  const id = input.id ?? `pub-${input.taskId}-${input.platform}`;

  const record: PublicationRecord = {
    id,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    cover: input.cover ?? null,
    platform: input.platform,
    publishedAt: input.publishedAt || now,
    title: input.title,
    status: input.status,
    ...(input.url ? { url: input.url } : {}),
    metrics: {
      views: input.metrics?.views ?? 0,
      likes: input.metrics?.likes ?? 0,
      comments: input.metrics?.comments ?? 0,
      shares: input.metrics?.shares ?? 0,
      updatedAt: input.metrics?.updatedAt ?? now,
    },
  };

  const index = existing.findIndex(p => p.id === id);
  if (index >= 0) {
    const prev = existing[index]!;
    existing[index] = { ...prev, ...record, metrics: { ...(prev.metrics ?? {}), ...record.metrics } };
  } else {
    existing.unshift(record);
  }

  await atomicJson(publicationsFile(dataDirectory), existing);
  return record;
}

export async function updatePublicationMetrics(
  dataDirectory: string,
  id: string,
  metrics: Partial<PublicationMetrics>,
  url?: string
): Promise<PublicationRecord | null> {
  const existing = await loadPublications(dataDirectory);
  const item = existing.find(p => p.id === id);
  if (!item) return null;

  if (url !== undefined) item.url = url;
  item.metrics = {
    ...item.metrics,
    ...metrics,
    updatedAt: new Date().toISOString(),
  };

  await atomicJson(publicationsFile(dataDirectory), existing);
  return item;
}

export async function deletePublication(dataDirectory: string, id: string): Promise<void> {
  const existing = await loadPublications(dataDirectory);
  const filtered = existing.filter(p => p.id !== id && p.taskId !== id);
  await atomicJson(publicationsFile(dataDirectory), filtered);
}

export interface ScrapedNoteMetric {
  title: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  url?: string | undefined;
  publishedAt?: string | undefined;
}

export function normalizeTitleForComparison(title: string): string {
  return title
    .replace(/#[^\s#]+/g, '')
    .replace(/@[^\s@]+/g, '')
    .replace(/[\s#＃|｜\-_—.,，!！?？:：()（）\[\]【】"“”'‘’]/g, '')
    .toLowerCase()
    .trim();
}

export function calculateTitleSimilarity(titleA: string, titleB: string): number {
  const a = normalizeTitleForComparison(titleA);
  const b = normalizeTitleForComparison(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.9;

  const minPrefix = Math.min(a.length, b.length, 8);
  if (minPrefix >= 4 && a.slice(0, minPrefix) === b.slice(0, minPrefix)) {
    return 0.85;
  }

  const getBigrams = (str: string) => {
    const s = new Set<string>();
    for (let i = 0; i < str.length - 1; i++) s.add(str.slice(i, i + 2));
    return s;
  };
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  if (!bigramsA.size || !bigramsB.size) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export async function syncPlatformMetrics(
  dataDirectory: string,
  platform: TargetPlatform,
  scrapedNotes: ScrapedNoteMetric[]
): Promise<{ updatedCount: number; matchedIds: string[] }> {
  const existing = await loadPublications(dataDirectory);
  const platformPubs = existing.filter(p => p.platform === platform);

  if (!platformPubs.length || !scrapedNotes.length) {
    return { updatedCount: 0, matchedIds: [] };
  }

  let updatedCount = 0;
  const matchedIds: string[] = [];
  const usedScrapedIndices = new Set<number>();

  for (const pub of platformPubs) {
    let bestMatchIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < scrapedNotes.length; i++) {
      if (usedScrapedIndices.has(i)) continue;
      const scraped = scrapedNotes[i];
      if (!scraped) continue;

      if (pub.url && scraped.url && pub.url === scraped.url) {
        bestMatchIdx = i;
        bestScore = 1.0;
        break;
      }

      const score = calculateTitleSimilarity(pub.title, scraped.title);
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        bestMatchIdx = i;
      }
    }

    if (bestMatchIdx === -1) {
      if (platformPubs.length === 1 && scrapedNotes.length === 1 && !usedScrapedIndices.has(0)) {
        bestMatchIdx = 0;
      } else {
        // 当标题相似度较低但按时间/顺序列表匹配时
        const pubIdx = platformPubs.indexOf(pub);
        if (pubIdx >= 0 && pubIdx < scrapedNotes.length && !usedScrapedIndices.has(pubIdx)) {
          const candidate = scrapedNotes[pubIdx];
          if (candidate) {
            const looseScore = calculateTitleSimilarity(pub.title, candidate.title);
            if (looseScore >= 0.25) {
              bestMatchIdx = pubIdx;
            }
          }
        }
      }
    }

    if (bestMatchIdx >= 0) {
      const scraped = scrapedNotes[bestMatchIdx];
      if (scraped) {
        usedScrapedIndices.add(bestMatchIdx);
        matchedIds.push(pub.id);

        const oldMetrics = pub.metrics || { views: 0, likes: 0, comments: 0, shares: 0 };
        pub.metrics = {
          views: Math.max(oldMetrics.views, scraped.views),
          likes: Math.max(oldMetrics.likes, scraped.likes),
          comments: Math.max(oldMetrics.comments, scraped.comments),
          shares: Math.max(oldMetrics.shares, scraped.shares),
          updatedAt: new Date().toISOString(),
        };
        if (scraped.url && !pub.url) {
          pub.url = scraped.url;
        }
        updatedCount++;
      }
    }
  }

  if (updatedCount > 0) {
    await atomicJson(publicationsFile(dataDirectory), existing);
  }

  return { updatedCount, matchedIds };
}
