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
    existing[index] = { ...existing[index], ...record, metrics: { ...(existing[index]?.metrics ?? {}), ...record.metrics } };
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
