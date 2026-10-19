import { chromium, type BrowserContext, type Page, type BrowserType, type Locator } from 'playwright';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, isRecord } from '../fetcher/store.js';
import { TARGET_PLATFORMS, type LocalizedCopy, type TargetPlatform } from '../rewriter/types.js';
import { PLATFORM_ADAPTERS, platformHost, creatorRoute } from './platforms.js';
import { syncPlatformMetrics, type ScrapedNoteMetric } from './publications.js';

export type AccountState = 'disconnected' | 'connecting' | 'connected';
export interface PlatformAccount { platform: TargetPlatform; state: AccountState; checkedAt: string | null; windowOpen: boolean }
export interface PublishInput { platform: TargetPlatform; videoPath: string; copy: LocalizedCopy }
export interface PublishResult { platform: TargetPlatform; uploaded: boolean; filled: string[]; warnings: string[]; manualConfirmation: true }
export interface SyncMetricsResult { succeeded: TargetPlatform[]; failed: Array<{ platform: TargetPlatform; error: string }>; updatedCount: number }

export class PublisherError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PublisherError'; }
}

export interface PublisherOptions {
  dataDirectory: string;
  onAccount?: (account: PlatformAccount) => void;
  loginTimeoutMs?: number;
  pollMs?: number;
  fieldTimeoutMs?: number;
}

function parseNumValue(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.replace(/,/g, '').trim();
    const w = s.match(/([\d.]+)\s*[wW万]/);
    if (w && w[1]) return Math.round(parseFloat(w[1]) * 10000);
    const k = s.match(/([\d.]+)\s*[kK]/);
    if (k && k[1]) return Math.round(parseFloat(k[1]) * 1000);
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function parseApiResponse(
  platform: TargetPlatform,
  _url: string,
  json: unknown,
  collector: (note: ScrapedNoteMetric) => void
): void {
  if (!json || typeof json !== 'object') return;

  function handleItem(item: any) {
    if (!item || typeof item !== 'object') return;
    const archive = item.Archive || item.archive || item;
    const title = archive.title || archive.display_title || archive.caption || archive.desc || item.title || item.display_title || item.caption;
    if (!title || typeof title !== 'string' || !title.trim()) return;

    const id = archive.bvid || archive.note_id || archive.noteId || archive.item_id || archive.aweme_id || archive.photoId || archive.id || item.note_id || item.id;
    let noteUrl: string | undefined;
    if (id) {
      if (platform === 'xiaohongshu') noteUrl = `https://www.xiaohongshu.com/explore/${id}`;
      else if (platform === 'bilibili') noteUrl = `https://www.bilibili.com/video/${id}`;
      else if (platform === 'douyin') noteUrl = `https://www.douyin.com/video/${id}`;
      else if (platform === 'kuaishou') noteUrl = `https://www.kuaishou.com/short-video/${id}`;
    }

    const stat = archive.stat || archive.statistics || archive.interact_info || archive.counts || item.stat || item.statistics || item.interact_info || item.counts || {};

    const views = parseNumValue(
      archive.read_count ?? archive.read_num ?? archive.view_count ?? archive.view_num ?? archive.views ?? archive.play_count ?? archive.playCount ?? archive.viewCount ?? archive.impressions ??
      stat.view ?? stat.view_count ?? stat.read_count ?? stat.play_count ?? stat.views ?? stat.playCount ?? stat.viewCount ?? stat.show_count ?? archive.video_play_count ?? archive.play_count ?? stat.play_count_valid ?? stat.vv ??
      item.read_count ?? item.view_count ?? item.play_count ?? item.viewCount ?? 0
    );

    const likes = parseNumValue(
      archive.like_count ?? archive.like_num ?? archive.liked_count ?? archive.likes ?? archive.digg_count ?? archive.likeCount ??
      stat.like ?? stat.like_count ?? stat.liked_count ?? stat.digg_count ?? stat.likes ?? stat.likeCount ?? stat.diggCount ?? archive.video_like_count ?? archive.digg_count ??
      item.like_count ?? item.liked_count ?? item.likeCount ?? 0
    );

    const comments = parseNumValue(
      archive.comment_count ?? archive.comment_num ?? archive.comments ?? archive.reply ?? archive.reply_count ?? archive.commentCount ??
      stat.reply ?? stat.comment ?? stat.comment_count ?? stat.comments ??
      item.comment_count ?? item.commentCount ?? 0
    );

    const shares = parseNumValue(
      archive.share_count ?? archive.share_num ?? archive.shares ?? archive.shareCount ??
      stat.share ?? stat.share_count ?? stat.shares ??
      item.share_count ?? item.shareCount ?? 0
    );

    const publishedAt = archive.ctime
      ? new Date(archive.ctime * 1000).toISOString()
      : typeof archive.publish_time === 'string'
        ? archive.publish_time
        : typeof archive.create_time === 'string'
          ? archive.create_time
          : undefined;

    collector({
      title: title.trim(),
      views,
      likes,
      comments,
      shares,
      ...(noteUrl ? { url: noteUrl } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }

  function findArrays(obj: any, depth = 0) {
    if (!obj || depth > 4) return;
    if (Array.isArray(obj)) {
      for (const el of obj) {
        if (el && typeof el === 'object') handleItem(el);
      }
      return;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (Array.isArray(val)) {
          for (const el of val) {
            if (el && typeof el === 'object') handleItem(el);
          }
        } else if (typeof val === 'object' && val !== null) {
          findArrays(val, depth + 1);
        }
      }
    }
  }

  findArrays(json);
}

export class PublisherService {
  private readonly accounts = new Map<TargetPlatform, PlatformAccount>();
  private readonly contexts = new Map<TargetPlatform, BrowserContext>();
  private readonly busy = new Set<TargetPlatform>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: PublisherOptions, private readonly launcher: Pick<BrowserType, 'launchPersistentContext'> = chromium) {
    for (const platform of TARGET_PLATFORMS) this.accounts.set(platform, { platform, state: 'disconnected', checkedAt: null, windowOpen: false });
  }

  private validate(platform: unknown): asserts platform is TargetPlatform {
    if (!TARGET_PLATFORMS.includes(platform as TargetPlatform)) throw new PublisherError('INVALID_PLATFORM', '请选择受支持的平台。');
  }

  list(): PlatformAccount[] { return [...this.accounts.values()].map(account => ({ ...account })); }

  async load(): Promise<void> {
    try {
      const file = path.join(this.options.dataDirectory, 'profiles', 'accounts.json');
      const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return;
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(saved)) return;
      for (const entry of saved) if (isRecord(entry) && TARGET_PLATFORMS.includes(entry.platform as TargetPlatform) && entry.state === 'connected' && typeof entry.checkedAt === 'string') {
        this.accounts.set(entry.platform as TargetPlatform, { platform: entry.platform as TargetPlatform, state: 'connected', checkedAt: entry.checkedAt, windowOpen: false });
      }
    } catch { /* Missing or unreadable state is disconnected, never inferred from profile presence. */ }
  }

  private emit(account: PlatformAccount): void {
    try { this.options.onAccount?.({ ...account }); } catch { /* Observers must not break account lifecycle or cleanup. */ }
  }

  private update(platform: TargetPlatform, state: AccountState): PlatformAccount {
    const account = { platform, state, checkedAt: state === 'connected' ? new Date().toISOString() : this.accounts.get(platform)?.checkedAt ?? null, windowOpen: this.contexts.has(platform) };
    this.accounts.set(platform, account); this.emit(account); return { ...account };
  }

  private async save(): Promise<void> { await atomicJson(path.join(this.options.dataDirectory, 'profiles', 'accounts.json'), this.list().map(account => ({ ...account, windowOpen: false, state: account.state === 'connecting' ? 'disconnected' : account.state }))); }

  private run<T>(platform: TargetPlatform, operation: () => Promise<T>): Promise<T> {
    this.validate(platform);
    if (this.closed) return Promise.reject(new PublisherError('CLOSED', '发布服务已关闭。'));
    if (this.busy.has(platform) || this.contexts.has(platform)) return Promise.reject(new PublisherError('PROFILE_BUSY', '该平台窗口已打开，请先完成操作或关闭窗口。'));
    this.busy.add(platform);
    const pending = operation().finally(() => { this.busy.delete(platform); this.pending.delete(pending); });
    this.pending.add(pending); return pending;
  }

  private async launchContext(directory: string, launchOptions: Parameters<BrowserType['launchPersistentContext']>[1]): Promise<BrowserContext> {
    try {
      return await this.launcher.launchPersistentContext(directory, launchOptions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Executable doesn't exist") || msg.includes('Failed to launch')) {
        try {
          return await this.launcher.launchPersistentContext(directory, { ...launchOptions, channel: 'chrome' });
        } catch {
          try {
            return await this.launcher.launchPersistentContext(directory, { ...launchOptions, channel: 'msedge' });
          } catch {
            throw new PublisherError('BROWSER_UNAVAILABLE', '无法启动浏览器；请先运行 npm run setup:browser 或安装 Chrome/Edge。');
          }
        }
      }
      throw err;
    }
  }

  private async open(platform: TargetPlatform): Promise<{ context: BrowserContext; page: Page }> {
    const directory = path.join(this.options.dataDirectory, 'profiles', platform);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new PublisherError('INVALID_PROFILE', '账号目录无效。');
    let context: BrowserContext;
    try {
      context = await this.launchContext(directory, {
        headless: false,
        viewport: null,
        acceptDownloads: false,
        permissions: [],
        ignoreHTTPSErrors: true,
        args: [
          '--ignore-certificate-errors',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=OriginKeyedAgentClusters',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
        timeout: 30000,
      });
    } catch (err) {
      if (err instanceof PublisherError) throw err;
      throw new PublisherError('BROWSER_UNAVAILABLE', '无法启动 Chromium；请先运行 npm run setup:browser，并确认该账号目录未被占用。');
    }
    if (this.closed) { await context.close(); throw new PublisherError('CLOSED', '发布服务已关闭。'); }
    this.contexts.set(platform, context);
    context.on('close', () => { this.contexts.delete(platform); const previous = this.accounts.get(platform)!; this.accounts.set(platform, { ...previous, windowOpen: false }); this.emit({ ...previous, windowOpen: false }); });
    if (typeof context.setDefaultTimeout === 'function') {
      context.setDefaultTimeout(this.options.fieldTimeoutMs ?? 20000);
    }
    const page = context.pages()[0] ?? await context.newPage();
    if (typeof page.addInitScript === 'function') {
      await page.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          (window as any).chrome = (window as any).chrome || { runtime: {} };
        } catch {}
      }).catch(() => {});
    }
    this.update(platform, 'connecting');
    return { context, page };
  }

  async isLoggedIn(platform: TargetPlatform, context: BrowserContext, page: Page): Promise<boolean> {
    if (page.isClosed() || !platformHost(platform, page.url())) return false;
    const adapter = PLATFORM_ADAPTERS[platform];
    const credentials = context.cookies().then(cookies => new Set(cookies.filter(cookie => cookie.value.trim()
      && (cookie.expires === -1 || cookie.expires > Date.now() / 1000)
      && platformHost(platform, `https://${cookie.domain.replace(/^\./, '')}`)).map(cookie => cookie.name)));
    const visible = async (): Promise<boolean> => {
      if (!creatorRoute(platform, page.url())) return false;
      return Promise.any(adapter.signedIn.map(async selector => {
        if (await page.locator(selector).first().isVisible()) return true;
        throw new Error('Not visible');
      })).catch(() => false);
    };
    return Promise.any([
      credentials.then(names => { if (adapter.coreCookies.every(name => names.has(name))) return true; throw new Error('No core credentials'); }),
      Promise.all([credentials, visible()]).then(([names, signedIn]) => {
        if (signedIn && adapter.cookies.some(name => names.has(name))) return true;
        throw new Error('No corroborated session');
      }),
    ]).catch(() => false);
  }

  private async authenticate(platform: TargetPlatform, context: BrowserContext, page: Page): Promise<void> {
    void page.goto(PLATFORM_ADAPTERS[platform].home, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const deadline = Date.now() + (this.options.loginTimeoutMs ?? 180000);
    while (Date.now() < deadline) {
      if (this.closed || page.isClosed() || !this.contexts.has(platform)) throw new PublisherError('LOGIN_CANCELLED', '登录窗口已关闭。');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const loggedIn = await Promise.race([
        this.isLoggedIn(platform, context, page),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.min(1000, Math.max(1, deadline - Date.now()))); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (this.closed || page.isClosed() || !this.contexts.has(platform)) throw new PublisherError('LOGIN_CANCELLED', '登录窗口已关闭。');
      if (loggedIn) { this.update(platform, 'connected'); await this.save(); return; }
      await new Promise(resolve => setTimeout(resolve, Math.min(this.options.pollMs ?? 1000, Math.max(0, deadline - Date.now()))));
    }
    throw new PublisherError('LOGIN_TIMEOUT', '未检测到有效登录。请重新连接；如平台改版，请检查页面并更新适配器。');
  }

  connect(platform: TargetPlatform): Promise<PlatformAccount> {
    return this.run(platform, async () => {
      let context: BrowserContext | undefined;
      try {
        const opened = await this.open(platform); context = opened.context;
        await this.authenticate(platform, context, opened.page);
        await context.close(); return this.accounts.get(platform)!;
      } catch (error) {
        this.update(platform, 'disconnected'); await this.save().catch(() => {}); await context?.close().catch(() => {});
        if (error instanceof PublisherError) throw error;
        throw new PublisherError('LOGIN_FAILED', '登录检查失败，请检查网络后重试。');
      }
    });
  }

  private async field(page: Page, platform: TargetPlatform, selectors: string[], action: (locator: Locator) => Promise<void>): Promise<boolean> {
    const deadline = Date.now() + (this.options.fieldTimeoutMs ?? 20000);
    do {
      if (page.isClosed() || !platformHost(platform, page.url())) return false;
      for (const frame of page.frames()) {
        const frameUrl = frame.url();
        if (frameUrl && !platformHost(platform, frameUrl) && !frameUrl.startsWith('about:')) continue;
        for (const selector of selectors) {
          const locator = frame.locator(selector).first();
          if (await locator.count().catch(() => 0)) {
            try { await action(locator); return true; } catch { /* Keep alternate selectors, never guess final submission. */ }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 300));
    } while (Date.now() < deadline);
    return false;
  }

  publish(input: PublishInput): Promise<PublishResult> {
    return this.run(input.platform, async () => {
      const { platform } = input;
      let context: BrowserContext | undefined;
      let authenticated = false;
      try {
        const entry = await lstat(input.videoPath);
        if (!path.isAbsolute(input.videoPath) || !entry.isFile() || entry.isSymbolicLink() || !entry.size || path.extname(input.videoPath).toLowerCase() !== '.mp4') throw new PublisherError('INVALID_MEDIA', '成品视频无效。');
        const opened = await this.open(platform); context = opened.context;
        const page = opened.page;
        await this.authenticate(platform, context, page); authenticated = true;
        await page.goto(PLATFORM_ADAPTERS[platform].upload, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const adapter = PLATFORM_ADAPTERS[platform];

        if (platform === 'bilibili') {
          // 若之前发布已完成停留在“投递成功”或弹出草稿提示，自动点击继续/重置为新投稿
          try {
            const continueBtn = page.locator('button:has-text("继续投稿"), a:has-text("继续投稿"), button:has-text("再投一个")').first();
            if (await continueBtn.isVisible().catch(() => false)) {
              await continueBtn.click().catch(() => {});
              await new Promise(r => setTimeout(r, 800));
            }
          } catch {}
          try {
            const discardBtn = page.locator('button:has-text("放弃草稿"), button:has-text("不恢复"), [class*="discard"]').first();
            if (await discardBtn.isVisible().catch(() => false)) {
              await discardBtn.click().catch(() => {});
              await new Promise(r => setTimeout(r, 600));
            }
          } catch {}
        }
        const result: PublishResult = { platform, uploaded: false, filled: [], warnings: [], manualConfirmation: true };
        result.uploaded = await this.field(page, platform, adapter.video, locator => locator.setInputFiles(input.videoPath, { timeout: 20000 }));
        if (result.uploaded) {
          // 视频文件注入后，等待 B站上传组件建立分片并切换至稿件信息编辑状态
          await new Promise(r => setTimeout(r, 1200));
        }
        if (!result.uploaded) result.warnings.push('未找到视频上传控件，请在窗口中手动上传。');
        const title = await this.field(page, platform, adapter.title, locator => locator.fill(input.copy.title, { timeout: 3000 }));
        if (title) result.filled.push('标题'); else result.warnings.push('标题未能自动填写，请手动检查。');
        const body = [input.copy.hook, input.copy.body, input.copy.tags.map(tag => '#' + tag.replace(/^#/, '')).join(' ')].filter(Boolean).join('\n\n');
        if (await this.field(page, platform, adapter.body, locator => locator.fill(body, { timeout: 3000 }))) result.filled.push('简介与标签文本');
        else result.warnings.push('简介与标签未能自动填写，请从工作台复制。');
        result.warnings.push('请检查上传进度、话题绑定、封面、分区及版权声明，并在平台页面最终确认发布。');
        return result; // Browser intentionally remains open for human review. No final publish click exists.
      } catch (error) {
        if (!authenticated) this.update(platform, 'disconnected');
        await this.save().catch(() => {}); await context?.close().catch(() => {});
        if (error instanceof PublisherError) throw error;
        throw new PublisherError('PREFILL_FAILED', '发布预填中断，未自动发布。请重新打开平台或手动上传。');
      }
    });
  }

  async scrapeCreatorMetrics(platform: TargetPlatform): Promise<ScrapedNoteMetric[]> {
    this.validate(platform);
    if (this.closed) throw new PublisherError('CLOSED', '发布服务已关闭。');

    const account = this.accounts.get(platform);
    if (!account || account.state !== 'connected') {
      throw new PublisherError('AUTH_REQUIRED', `未登录 ${PLATFORM_ADAPTERS[platform].name} 账号，无法同步数据。`);
    }

    if (this.busy.has(platform)) {
      throw new PublisherError('PROFILE_BUSY', `${PLATFORM_ADAPTERS[platform].name} 正在进行发布或操作，请稍候再试。`);
    }

    const adapter = PLATFORM_ADAPTERS[platform];
    const directory = path.join(this.options.dataDirectory, 'profiles', platform);

    let context = this.contexts.get(platform);
    let isTemporary = false;

    if (!context) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new PublisherError('INVALID_PROFILE', '账号目录无效。');

      const launchOptions = {
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
          '--ignore-certificate-errors',
          '--disable-features=OriginKeyedAgentClusters',
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-infobars',
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        timeout: 25000,
      };

      try {
        context = await this.launchContext(directory, launchOptions);
        isTemporary = true;
      } catch (err) {
        if (err instanceof PublisherError) throw err;
        throw new PublisherError('BROWSER_UNAVAILABLE', `无法启动浏览器同步 ${adapter.name} 数据：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const scrapedList: ScrapedNoteMetric[] = [];
    const seenTitles = new Set<string>();

    const addScraped = (note: ScrapedNoteMetric) => {
      if (!note.title) return;
      const key = note.title.trim().toLowerCase();
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        scrapedList.push(note);
      } else {
        const existing = scrapedList.find(s => s.title.trim().toLowerCase() === key);
        if (existing) {
          existing.views = Math.max(existing.views, note.views);
          existing.likes = Math.max(existing.likes, note.likes);
          existing.comments = Math.max(existing.comments, note.comments);
          existing.shares = Math.max(existing.shares, note.shares);
          if (note.url && !existing.url) existing.url = note.url;
        }
      }
    };

    let page: Page | undefined;
    try {
      page = await context.newPage();
      if (typeof page.setDefaultTimeout === 'function') {
        page.setDefaultTimeout(this.options.fieldTimeoutMs ?? 15000);
      if (typeof page.addInitScript === 'function') {
        await page.addInitScript(() => {
          try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          } catch {}
        }).catch(() => {});
      }
      }

      if (typeof page.on === 'function') {
        page.on('response', async (res) => {
          try {
            const u = res.url();
            const ct = (res.headers && res.headers()['content-type']) || '';
            if (!ct.includes('json') && !ct.includes('javascript') && !ct.includes('text/plain')) return;
            if (
              u.includes('note') ||
              u.includes('creator') ||
              u.includes('article') ||
              u.includes('archives') ||
              u.includes('item/list') ||
              u.includes('works') ||
              u.includes('video/list') ||
              u.includes('galaxy') || u.includes('aweme') || u.includes('rest/cp') || u.includes('manage') || u.includes('item_list') || u.includes('cp/works') || u.includes('douyin.com') || u.includes('kuaishou.com')
            ) {
              const bodyText = await res.text().catch(() => '');
              if (!bodyText || bodyText.length > 3 * 1024 * 1024) return;
              const data = JSON.parse(bodyText);
              parseApiResponse(platform, u, data, addScraped);
            }
          } catch {
            // ignore JSON parse or read errors
          }
        });
      }

            // 1. 精准导航到各平台作品管理页 (Direct Precision Navigation)
      if (platform === 'douyin') {
        const douyinManageUrl = 'https://creator.douyin.com/creator-micro/content/manage';
        await page.goto(douyinManageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        if (typeof page.waitForSelector === 'function') {
          await page.waitForSelector('[class*="content-manage"], [class*="manage-card"], [class*="table"], [class*="semi-table"]', { timeout: 8000 }).catch(() => {});
        }
      } else if (platform === 'kuaishou') {
        const kuaishouManageUrl = 'https://cp.kuaishou.com/article/manage/video';
        await page.goto(kuaishouManageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        if (typeof page.waitForSelector === 'function') {
          await page.waitForSelector('[class*="work"], [class*="video"], [class*="table"], [class*="card"]', { timeout: 8000 }).catch(() => {});
        }
      } else {
        await page.goto(adapter.manage || adapter.home, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      }

      await new Promise(r => setTimeout(r, 2000));
      if (typeof page.evaluate === 'function') {
        await page.evaluate(() => {
          try { (globalThis as any).window?.scrollBy(0, 600); } catch {}
        }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 2000));

      if (typeof page.evaluate === 'function') {
        if (platform === 'bilibili' && scrapedList.length === 0) {
          try {
            const biliData = await page.evaluate(async () => {
              try {
                const r = await (globalThis as any).fetch('https://member.bilibili.com/x/web/archives?status=is_pubing%2Cpubed%2Cnot_pubed&pn=1&ps=20', { credentials: 'include' });
                return await r.json();
              } catch { return null; }
            });
            if (biliData) parseApiResponse(platform, 'member.bilibili.com/x/web/archives', biliData, addScraped);
          } catch {}
        } else if (platform === 'douyin' && scrapedList.length === 0) {
          try {
            const dyData = await page.evaluate(async () => {
              try {
                const r = await (globalThis as any).fetch('/web/api/media/aweme/post/?count=20&max_cursor=0', { credentials: 'include' });
                return await r.json();
              } catch {
                try {
                  const r2 = await (globalThis as any).fetch('/creator-micro/item/list?count=20', { credentials: 'include' });
                  return await r2.json();
                } catch { return null; }
              }
            });
            if (dyData) parseApiResponse(platform, 'creator.douyin.com/web/api/media/aweme/post/', dyData, addScraped);
          } catch {}
        } else if (platform === 'kuaishou' && scrapedList.length === 0) {
          try {
            const ksData = await page.evaluate(async () => {
              try {
                const r = await (globalThis as any).fetch('/rest/cp/works/list?workType=0&page=1&pageSize=20', { credentials: 'include' });
                return await r.json();
              } catch {
                try {
                  const r2 = await (globalThis as any).fetch('/rest/cp/works/video/list?page=1&pageSize=20', { credentials: 'include' });
                  return await r2.json();
                } catch { return null; }
              }
            });
            if (ksData) parseApiResponse(platform, 'cp.kuaishou.com/rest/cp/works/list', ksData, addScraped);
          } catch {}
        }
      }

      if (typeof page.evaluate === 'function') {
        try {
          const domItems = await page.evaluate(() => {
            const win = globalThis as unknown as { document?: { querySelectorAll: (s: string) => any[] } };
            const doc = typeof (globalThis as any).document !== 'undefined' ? (globalThis as any).document : win.document;
            if (!doc) return [];
            const items: Array<{ title: string; views: number; likes: number; comments: number; shares: number; url?: string }> = [];
            function parseNum(str: string): number {
              if (!str) return 0;
              const s = str.replace(/,/g, '').trim();
              const wMatch = s.match(/([\d.]+)\s*[wW万]/);
              if (wMatch && wMatch[1]) return Math.round(parseFloat(wMatch[1]) * 10000);
              const kMatch = s.match(/([\d.]+)\s*[kK]/);
              if (kMatch && kMatch[1]) return Math.round(parseFloat(kMatch[1]) * 1000);
              const numMatch = s.match(/\d+/);
              return numMatch && numMatch[0] ? parseInt(numMatch[0], 10) : 0;
            }

            const rows = doc.querySelectorAll(
              'tbody tr, [class*="note-card"], [class*="noteCard"], [class*="note-item"], [class*="noteItem"], [class*="content-item"], [class*="item-card"], [class*="work-item"], [class*="video-item"], [class*="article-item"], [class*="card-item"], [class*="table-row"], [class*="semi-table-row"]'
            );

            for (const r of Array.from(rows)) {
              const row = r as { innerText?: string; querySelector?: (s: string) => any; querySelectorAll?: (s: string) => any[] };
              const rowText = row.innerText || '';
              if (rowText.length < 4 || !row.querySelector) continue;

              const titleEl = row.querySelector('[class*="title"], [class*="Title"], [class*="caption"], [class*="desc"], [class*="name"], h3, h4, a[title]');
              let title = (titleEl?.getAttribute?.('title') || titleEl?.textContent || '').trim();
              if (!title) {
                const lines = rowText.split('\n').map((s: string) => s.trim()).filter((s: string) => s.length > 2);
                if (lines[0] && !/^(已发布|审核中|播放|点赞|数据)/.test(lines[0])) {
                  title = lines[0];
                }
              }
              if (!title) return;

              const linkEl = row.querySelector('a[href*="/explore/"], a[href*="/video/"], a[href*="bilibili.com/video"], a[href*="kuaishou.com/short-video"], a[href*="douyin.com/video"]');
              const url = linkEl?.href ? String(linkEl.href) : undefined;

              let views = 0, likes = 0, comments = 0, shares = 0;
              const vMatch = rowText.match(/(?:播放|阅读|观看|展现|曝光)[^\d]*([\d.,]+[wWkK万]?)/i);
              if (vMatch && vMatch[1]) views = parseNum(vMatch[1]);

              const lMatch = rowText.match(/(?:点赞|获赞|赞)[^\d]*([\d.,]+[wWkK万]?)/i);
              if (lMatch && lMatch[1]) likes = parseNum(lMatch[1]);

              const cMatch = rowText.match(/(?:评论|留言)[^\d]*([\d.,]+[wWkK万]?)/i);
              if (cMatch && cMatch[1]) comments = parseNum(cMatch[1]);

              const sMatch = rowText.match(/(?:分享|转发)[^\d]*([\d.,]+[wWkK万]?)/i);
              if (sMatch && sMatch[1]) shares = parseNum(sMatch[1]);

              // 针对快手和抖音常见的指标纯数字列或卡片结构兜底
              if (views === 0) {
                const statCols = Array.from(row.querySelectorAll?.('td, [class*="stat"], [class*="num"], [class*="count"], [class*="data"]') || []);
                for (const col of statCols) {
                  const txt = ((col as any)?.textContent || '').trim();
                  if (/^\d+[wWkK万]?$/.test(txt)) {
                    const val = parseNum(txt);
                    if (val > 0 && views === 0) {
                      views = val;
                    }
                  }
                }
              }

              items.push({ title, views, likes, comments, shares, ...(url ? { url } : {}) });
            }
            return items;
          });

          if (Array.isArray(domItems)) {
            for (const item of domItems) {
              addScraped(item);
            }
          }
        } catch {
          // DOM fallback safe
        }
      }
    } finally {
      if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      if (isTemporary && context) {
        await context.close().catch(() => {});
      }
    }

    return scrapedList;
  }

  async syncMetrics(dataDirectory: string, targetPlatform?: TargetPlatform): Promise<SyncMetricsResult> {
    const targets: TargetPlatform[] = targetPlatform ? [targetPlatform] : [...TARGET_PLATFORMS];
    const accounts = this.list();
    const connected = accounts.filter(a => a.state === 'connected').map(a => a.platform);
    const toSync = targets.filter(p => connected.includes(p));

    if (!toSync.length) {
      if (targetPlatform) {
        throw new PublisherError('AUTH_REQUIRED', `${PLATFORM_ADAPTERS[targetPlatform].name} 尚未登录，请先在“平台账号管理”中完成登录。`);
      }
      throw new PublisherError('NO_CONNECTED_PLATFORMS', '尚未登录任何平台账号，请先在“平台账号管理”中完成登录。');
    }

    const succeeded: TargetPlatform[] = [];
    const failed: Array<{ platform: TargetPlatform; error: string }> = [];
    let totalUpdated = 0;

    for (const plat of toSync) {
      try {
        const scraped = await this.scrapeCreatorMetrics(plat);
        const { updatedCount } = await syncPlatformMetrics(dataDirectory, plat, scraped);
        totalUpdated += updatedCount;
        succeeded.push(plat);
      } catch (err: unknown) {
        failed.push({
          platform: plat,
          error: err instanceof Error ? err.message : '数据探测失败',
        });
      }
    }

    return { succeeded, failed, updatedCount: totalUpdated };
  }

  async closePlatform(platform: TargetPlatform): Promise<void> { this.validate(platform); await this.contexts.get(platform)?.close(); }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.contexts.values()].map(context => context.close())); await Promise.allSettled([...this.pending]); }
}
