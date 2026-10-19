import type { TargetPlatform } from '../rewriter/types.js';
export interface PlatformAdapter {
  name: string; home: string; upload: string; manage: string; hosts: string[]; cookies: string[];
  /** All core credentials are required; fallback cookies need creator route + DOM. */
  coreCookies: string[]; creatorHost: string; creatorPath: RegExp;
  signedIn: string[]; video: string[]; title: string[]; body: string[];
}
/** Small, explicit selector matrix. Never includes the final publish/submit button. */
export const PLATFORM_ADAPTERS: Record<TargetPlatform, PlatformAdapter> = {
  douyin: {
    name: '抖音', home: 'https://creator.douyin.com/creator-micro/home', upload: 'https://creator.douyin.com/creator-micro/content/upload', manage: 'https://creator.douyin.com/creator-micro/content/manage', hosts: ['douyin.com'], cookies: ['sessionid', 'sessionid_ss'],
    coreCookies: ['sessionid'], creatorHost: 'creator.douyin.com', creatorPath: /^\/(?:creator-micro(?:\/|$)|$)/,
    signedIn: ['a[href*="content/upload"]', '[class*="creator-info"]', '[class*="userInfo"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]', 'input[type="file"]'],
    title: ['input[placeholder*="标题"]', 'input[placeholder*="作品"]'], body: ['[contenteditable="true"][data-placeholder*="描述"]', '[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
  },
  bilibili: {
    name: '哔哩哔哩', home: 'https://member.bilibili.com/platform/home', upload: 'https://member.bilibili.com/platform/upload/video', manage: 'https://member.bilibili.com/platform/upload-manager/article', hosts: ['bilibili.com'], cookies: ['SESSDATA'],
    coreCookies: ['DedeUserID', 'SESSDATA'], creatorHost: 'member.bilibili.com', creatorPath: /^\/(?:platform|york|video)(?:\/|$)/,
    signedIn: ['.header-avatar', '.user-avatar', '[class*="avatar"]', 'a[href*="upload/video"]', 'text="创作中心"'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]', 'input[placeholder*="稿件标题"]', '.video-title input', '[class*="content-title"] input', 'input[maxlength="80"]'], body: ['textarea[placeholder*="简介"]', 'textarea[placeholder*="填写更全面的视频信息"]', '[class*="desc-box"] textarea', '[contenteditable="true"]', 'textarea'],
  },
  kuaishou: {
    name: '快手', home: 'https://cp.kuaishou.com/', upload: 'https://cp.kuaishou.com/article/publish/video', manage: 'https://cp.kuaishou.com/article/manage/video', hosts: ['kuaishou.com'], cookies: ['passToken', 'kuaishou.server.web_st', 'kuaishou.server.web_ph'],
    coreCookies: ['passToken'], creatorHost: 'cp.kuaishou.com', creatorPath: /^\/(?:article(?:\/|$)|profile(?:\/|$)|$)/,
    signedIn: ['a[href*="article/publish"]', '[class*="user-info"]', '[class*="userInfo"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]'], body: ['textarea[placeholder*="描述"]', '[contenteditable="true"]', 'textarea'],
  },
  xiaohongshu: {
    name: '小红书', home: 'https://creator.xiaohongshu.com/', upload: 'https://creator.xiaohongshu.com/publish/publish?target=video', manage: 'https://creator.xiaohongshu.com/new/note-manager', hosts: ['xiaohongshu.com'], cookies: ['web_session', 'customer-sso-sid'],
    coreCookies: ['web_session'], creatorHost: 'creator.xiaohongshu.com', creatorPath: /^\/(?:publish(?:\/|$)|new(?:\/|$)|home(?:\/|$)|$)/,
    signedIn: ['a[href*="publish"]', '.user-info', '[class*="userInfo"]'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]'],
    title: ['input[placeholder*="标题"]'], body: ['[contenteditable="true"]', 'textarea[placeholder*="描述"]'],
  },
  channels: {
    name: '微信视频号', home: 'https://channels.weixin.qq.com/platform', upload: 'https://channels.weixin.qq.com/platform/post/create', manage: 'https://channels.weixin.qq.com/platform/post/list', hosts: ['channels.weixin.qq.com', 'weixin.qq.com', 'qq.com'], cookies: ['_finder_auth', 'sessionid', 'finder_auth'],
    coreCookies: ['_finder_auth'], creatorHost: 'channels.weixin.qq.com', creatorPath: /^\/(?:platform(?:\/|$)|$)/,
    signedIn: ['[class*="avatar"]', '[class*="finder-info"]', 'text="创作者服务平台"', 'a[href*="post/create"]', '.finder-nickname'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]', 'input[type="file"]'],
    title: ['input[placeholder*="标题"]', '[class*="title"] input'], body: ['textarea[placeholder*="描述"]', '[contenteditable="true"]', 'textarea'],
  },
};
export function platformHost(platform: TargetPlatform, url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && PLATFORM_ADAPTERS[platform].hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)); }
  catch { return false; }
}

/** A creator URL is corroboration, not authentication: logged-out SPAs use the same URL. */
export function creatorRoute(platform: TargetPlatform, url: string): boolean {
  try {
    const parsed = new URL(url); const adapter = PLATFORM_ADAPTERS[platform];
    return parsed.protocol === 'https:' && parsed.hostname === adapter.creatorHost
      && adapter.creatorPath.test(parsed.pathname) && !/(?:login|passport|signin)/i.test(parsed.pathname + parsed.hash);
  } catch { return false; }
}
