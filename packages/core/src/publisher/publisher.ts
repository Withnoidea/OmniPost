import { chromium, type BrowserContext, type Page, type BrowserType, type Locator } from 'playwright';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, isRecord } from '../fetcher/store.js';
import { TARGET_PLATFORMS, type LocalizedCopy, type TargetPlatform } from '../rewriter/types.js';
import { PLATFORM_ADAPTERS, platformHost, creatorRoute } from './platforms.js';

export type AccountState = 'disconnected' | 'connecting' | 'connected';
export interface PlatformAccount { platform: TargetPlatform; state: AccountState; checkedAt: string | null; windowOpen: boolean }
export interface PublishInput { platform: TargetPlatform; videoPath: string; copy: LocalizedCopy }
export interface PublishResult { platform: TargetPlatform; uploaded: boolean; filled: string[]; warnings: string[]; manualConfirmation: true }
export class PublisherError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PublisherError'; }
}
export interface PublisherOptions { dataDirectory: string; onAccount?: (account: PlatformAccount) => void; loginTimeoutMs?: number; pollMs?: number; fieldTimeoutMs?: number }
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
  private async open(platform: TargetPlatform): Promise<{ context: BrowserContext; page: Page }> {
    const directory = path.join(this.options.dataDirectory, 'profiles', platform);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new PublisherError('INVALID_PROFILE', '账号目录无效。');
    let context: BrowserContext;
    try { context = await this.launcher.launchPersistentContext(directory, { headless: false, viewport: null, acceptDownloads: false, permissions: [], timeout: 30000 }); }
    catch { throw new PublisherError('BROWSER_UNAVAILABLE', '无法启动 Chromium；请先运行 npm run setup:browser，并确认该账号目录未被占用。'); }
    if (this.closed) { await context.close(); throw new PublisherError('CLOSED', '发布服务已关闭。'); }
    this.contexts.set(platform, context);
    context.on('close', () => { this.contexts.delete(platform); const previous = this.accounts.get(platform)!; this.accounts.set(platform, { ...previous, windowOpen: false }); this.emit({ ...previous, windowOpen: false }); });
    context.setDefaultTimeout(this.options.fieldTimeoutMs ?? 20000);
    const page = context.pages()[0] ?? await context.newPage();
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
      // Probe selectors concurrently; a stale selector must never delay a core-cookie success.
      return Promise.any(adapter.signedIn.map(async selector => {
        if (await page.locator(selector).first().isVisible()) return true;
        throw new Error('Not visible');
      })).catch(() => false);
    };
    return Promise.any([
      credentials.then(names => { if (adapter.coreCookies.every(name => names.has(name))) return true; throw new Error('No core credentials'); }),
      Promise.all([credentials, visible()]).then(([names, signedIn]) => {
        // Alternate session names need BOTH the actual creator route and creator DOM.
        // Neither URL nor an avatar/login heading alone is proof of authentication.
        if (signedIn && adapter.cookies.some(name => names.has(name))) return true;
        throw new Error('No corroborated session');
      }),
    ]).catch(() => false);
  }
  private async authenticate(platform: TargetPlatform, context: BrowserContext, page: Page): Promise<void> {
    // Login cookies can arrive while analytics/assets keep navigation pending. Start polling now.
    void page.goto(PLATFORM_ADAPTERS[platform].home, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const deadline = Date.now() + (this.options.loginTimeoutMs ?? 180000);
    while (Date.now() < deadline) {
      if (this.closed || page.isClosed() || !this.contexts.has(platform)) throw new PublisherError('LOGIN_CANCELLED', '登录窗口已关闭。');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const loggedIn = await Promise.race([
        this.isLoggedIn(platform, context, page),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.min(1000, Math.max(1, deadline - Date.now()))); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      // Closing a window during a probe must not emit a late Connected event.
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
        if (!platformHost(platform, frame.url())) continue;
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
        const result: PublishResult = { platform, uploaded: false, filled: [], warnings: [], manualConfirmation: true };
        result.uploaded = await this.field(page, platform, adapter.video, locator => locator.setInputFiles(input.videoPath, { timeout: 20000 }));
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
  async closePlatform(platform: TargetPlatform): Promise<void> { this.validate(platform); await this.contexts.get(platform)?.close(); }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.contexts.values()].map(context => context.close())); await Promise.allSettled([...this.pending]); }
}
