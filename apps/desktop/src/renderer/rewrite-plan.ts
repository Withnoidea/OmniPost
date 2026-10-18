import type { LocalizedCopy, TargetPlatform } from '../shared/contracts.js';
export const REWRITE_PLATFORMS: TargetPlatform[] = ['xiaohongshu', 'bilibili', 'douyin', 'kuaishou'];
export interface RewritePlan { targets: TargetPlatform[]; mode: 'missing' | 'replace'; confirm: boolean; blocked: boolean }
/** Drafts count as occupied: filling gaps must never replace saved or unsaved human work. */
export function planRewrite(all: boolean, selected: TargetPlatform, saved: Partial<Record<TargetPlatform, LocalizedCopy>>, drafts: Partial<Record<TargetPlatform, LocalizedCopy>>): RewritePlan {
  if (!all) return { targets: [selected], mode: 'replace', confirm: false, blocked: Boolean(drafts[selected]) };
  const missing = REWRITE_PLATFORMS.filter(platform => !saved[platform] && !drafts[platform]);
  return missing.length
    ? { targets: missing, mode: 'missing', confirm: false, blocked: false }
    : { targets: [...REWRITE_PLATFORMS], mode: 'replace', confirm: true, blocked: REWRITE_PLATFORMS.some(platform => Boolean(drafts[platform])) };
}
