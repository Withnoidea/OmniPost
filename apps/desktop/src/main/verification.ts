import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { CookieStore, cookieDomainAllowed } from '../../../../packages/core/src/fetcher/cookies.js';
import { normalizeSource } from '../../../../packages/core/src/fetcher/config.js';
import type { DownloadTask } from '../shared/contracts.js';
import { DesktopError } from './security.js';

/** No renderer IPC, preload, filesystem API or automated challenge-solving in remote windows. */
export class VerificationService {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly cookies: CookieStore;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private readonly finishing = new Set<string>();
  constructor(root: string) { this.cookies = new CookieStore(root); }
  private track(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new DesktopError('CLOSING', '验证服务正在关闭。'));
    const pending = operation().finally(() => { this.pending.delete(pending); });
    this.pending.add(pending); return pending;
  }
  open(task: DownloadTask): Promise<void> { return this.track(() => this.openWindow(task)); }
  private async openWindow(task: DownloadTask): Promise<void> {
    if (task.error?.code !== 'AUTH_REQUIRED') throw new DesktopError('INVALID_STATE', '此任务无需人工验证。');
    const current = this.windows.get(task.id);
    if (current && !current.isDestroyed()) { current.focus(); return; }
    const source = normalizeSource(task.sourceUrl);
    const isolated = session.fromPartition(`verification-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    const child = new BrowserWindow({ width: 1080, height: 800, title: 'OmniPost · 完成人工验证后返回工作台', autoHideMenuBar: true,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    this.windows.set(task.id, child);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allowed = (url: string): boolean => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && cookieDomainAllowed(source.platform, parsed.hostname); } catch { return false; } };
    child.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    child.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    child.on('closed', () => { this.windows.delete(task.id); void isolated.clearStorageData().catch(() => {}); });
    try { await child.loadURL(source.url); }
    catch { if (!child.isDestroyed()) child.close(); throw new DesktopError('VERIFY_LOAD_FAILED', '验证页面无法加载，请检查网络后重试。'); }
  }
  finish(task: DownloadTask): Promise<void> {
    return this.track(async () => {
      if (this.finishing.has(task.id)) throw new DesktopError('VERIFY_BUSY', '正在保存验证信息，请稍候。');
      this.finishing.add(task.id);
      try { await this.saveCookies(task); } finally { this.finishing.delete(task.id); }
    });
  }
  private async saveCookies(task: DownloadTask): Promise<void> {
    const child = this.windows.get(task.id);
    if (!child || child.isDestroyed()) throw new DesktopError('VERIFY_CLOSED', '验证窗口已关闭，请重新打开并完成验证。');
    await this.cookies.save(task.platform, (await child.webContents.session.cookies.get({})).map(cookie => ({ domain: cookie.domain ?? '', path: cookie.path ?? '/', name: cookie.name, value: cookie.value, secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly), ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }) })));
    if (!child.isDestroyed()) child.close();
  }
  async close(): Promise<void> { this.closed = true; for (const child of this.windows.values()) if (!child.isDestroyed()) child.destroy(); this.windows.clear(); await Promise.allSettled([...this.pending]); }
}
