import type { TargetPlatform } from '../rewriter/types.js';
export interface PlatformAdapter {
  name: string; home: string; upload: string; hosts: string[]; cookies: string[];
  signedIn: string[]; video: string[]; title: string[]; body: string[];
}
/** Small, explicit selector matrix. Never includes the final publish/submit button. */
export const PLATFORM_ADAPTERS: Record<TargetPlatform, PlatformAdapter> = {
  douyin: {
    name: '抖音', home: 'https://creator.douyin.com/creator-micro/home', upload: 'https://creator.douyin.com/creator-micro/content/upload', hosts: ['douyin.com'], cookies: ['sessionid', 'sessionid_ss'],
    signedIn: ['a[href*="content/upload"]', '[class*="creator-info"]', '[class*="userInfo"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]', 'input[placeholder*="作品"]'], body: ['[contenteditable="true"][data-placeholder*="描述"]', '[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
  },
  bilibili: {
    name: '哔哩哔哩', home: 'https://member.bilibili.com/platform/home', upload: 'https://member.bilibili.com/platform/upload/video/frame', hosts: ['bilibili.com'], cookies: ['SESSDATA'],
    signedIn: ['.header-avatar', '.user-avatar', 'a[href*="upload/video"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]', '.video-title input'], body: ['textarea[placeholder*="简介"]', '[contenteditable="true"]', 'textarea'],
  },
  kuaishou: {
    name: '快手', home: 'https://cp.kuaishou.com/', upload: 'https://cp.kuaishou.com/article/publish/video', hosts: ['kuaishou.com'], cookies: ['kuaishou.server.web_st', 'kuaishou.server.web_ph'],
    signedIn: ['a[href*="article/publish"]', '[class*="user-info"]', '[class*="userInfo"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]'], body: ['textarea[placeholder*="描述"]', '[contenteditable="true"]', 'textarea'],
  },
  xiaohongshu: {
    name: '小红书', home: 'https://creator.xiaohongshu.com/', upload: 'https://creator.xiaohongshu.com/publish/publish?target=video', hosts: ['xiaohongshu.com'], cookies: ['web_session', 'customer-sso-sid'],
    signedIn: ['a[href*="publish"]', '.user-info', '[class*="userInfo"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]'], body: ['[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
  },
};
export function platformHost(platform: TargetPlatform, url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && PLATFORM_ADAPTERS[platform].hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)); }
  catch { return false; }
}
