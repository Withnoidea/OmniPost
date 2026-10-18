import type { Platform } from '../types.js';

export interface ParsedMedia {
  id: string;
  platform: Platform;
  title: string;
  description: string;
  uploader: string | null;
  channel: string | null;
  durationSeconds: number | null;
  videoUrl: string;
  coverUrl: string | null;
  tags: string[];
  width?: number | null;
  height?: number | null;
  headers?: Record<string, string>;
}
