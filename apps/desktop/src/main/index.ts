import { StudioService } from './studio.js';
import { RewriterError } from '../../../../packages/core/src/rewriter/errors.js';
import { ProcessorError } from '../../../../packages/core/src/processor/types.js';
import { collectAnalytics } from '../../../../packages/core/src/telemetry.js';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DownloadScheduler } from '../../../../packages/core/src/fetcher/scheduler.js';
import { normalizeProxy, resolvePortableTools } from '../../../../packages/core/src/fetcher/config.js';
import { FetcherError } from '../../../../packages/core/src/fetcher/errors.js';
import { runProcess } from '../../../../packages/core/src/fetcher/process.js';
import { atomicJson, isRecord } from '../../../../packages/core/src/fetcher/store.js';
import type { DownloadTask } from '../../../../packages/core/src/fetcher/types.js';
import type { ProxySettings, Reply, TaskAssets } from '../shared/contracts.js';
import { assetPath, DesktopError, imageMime, taskId, text } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../../../..');
const dataDirectory = path.resolve(process.env.OMNIPOST_DATA_DIR ?? (app.isPackaged ? path.join(app.getPath('userData'), 'library') : path.join(project, '.omnipost')));
// Separate dev/QA Chromium profiles from production, but share the CLI asset library in normal dev.
if (!app.isPackaged) app.setPath('userData', path.join(dataDirectory, '.desktop'));
const tools = resolvePortableTools(app.isPackaged ? process.resourcesPath : path.join(project, 'resources'));
const settingsFile = path.join(app.getPath('userData'), 'proxy.json');
let proxy: ProxySettings = { enabled: false, url: 'http://127.0.0.1:7890', persisted: true };
let window: BrowserWindow | null = null;
let scheduler: DownloadScheduler | undefined;
let startupError: unknown;
let quitting = false;
const studio = new StudioService(dataDirectory, path.join(app.getPath('userData'), 'studio-settings.json'), tools, event => {
  if (window && !window.isDestroyed()) window.webContents.send('omni:studio', event);
});
const probes = new Set<AbortController>();
const sizeCache = new Map<string, { width: number | null; height: number | null }>();
const devURL = process.env.ELECTRON_RENDERER_URL;
const rendererFile = path.join(here, '../renderer/index.html');

function engine(): DownloadScheduler {
  if (!scheduler) throw startupError ?? new DesktopError('NOT_READY', '素材引擎尚未就绪，请重启应用。');
  return scheduler;
}
function getTask(input: unknown): DownloadTask {
  const task = engine().getTask(taskId(input));
  if (!task) throw new DesktopError('TASK_NOT_FOUND', '未找到该任务，请刷新后重试。');
  return task;
}
function authorized(event: IpcMainInvokeEvent): boolean {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  const url = new URL(event.senderFrame.url);
  return devURL ? url.origin === new URL(devURL).origin : url.protocol === 'file:' && fileURLToPath(url) === rendererFile;
}
function handle<T>(channel: string, action: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Reply<T>> => {
    try {
      if (!authorized(event)) throw new DesktopError('FORBIDDEN', '不允许的窗口请求。');
      return { ok: true, value: await action(...args) };
    } catch (error) {
      const known = error instanceof DesktopError || error instanceof FetcherError || error instanceof RewriterError || error instanceof ProcessorError;
      return { ok: false, error: { code: known ? error.code : 'DESKTOP_ERROR', message: known ? error.message : '本地操作失败，请检查文件权限后重试。' } };
    }
  });
}
async function loadProxy(): Promise<void> {
  try {
    const data: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (!isRecord(data) || typeof data.enabled !== 'boolean') return;
    const url = typeof data.encrypted === 'string' && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(data.encrypted, 'base64')) : data.url;
    if (typeof url === 'string') proxy = { enabled: data.enabled, url: normalizeProxy(url), persisted: true };
  } catch { /* Invalid or unavailable encrypted settings revert to explicit direct connection. */ }
}
async function saveProxy(input: unknown): Promise<ProxySettings> {
  if (!isRecord(input) || typeof input.enabled !== 'boolean' || typeof input.url !== 'string') throw new DesktopError('INVALID_PROXY', '请输入完整代理地址。');
  const url = normalizeProxy(input.url.trim());
  if (input.enabled && !url) throw new DesktopError('INVALID_PROXY', '开启代理前请填写地址。');
  const credentials = url && (new URL(url).username || new URL(url).password);
  const encrypted = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(url).toString('base64') : null;
  // Never persist credentials as plain text. Clear an earlier setting even when this one is memory-only.
  const persisted = Boolean(encrypted || !credentials);
  await atomicJson(settingsFile, encrypted ? { enabled: input.enabled, encrypted } : { enabled: persisted && input.enabled, url: persisted ? url : '' });
  proxy = { enabled: input.enabled, url, persisted };
  return proxy;
}
async function assets(input: unknown): Promise<TaskAssets> {
  const task = getTask(input);
  const manifest = task.asset ?? task.metadataAsset;
  const result: TaskAssets = { cover: null, video: null };
  if (!manifest) return result;
  const directory = engine().getAssetDirectory(task.id);
  // No file:// exposure or arbitrary filesystem IPC; only bounded raster images from the committed manifest.
  try {
    const coverFile = await assetPath(directory, manifest.thumbnail.file);
    if ((await stat(coverFile)).size <= 12 * 1024 * 1024) {
      const buffer = await readFile(coverFile);
      const mime = imageMime(buffer);
      if (mime) result.cover = `data:${mime};base64,${buffer.toString('base64')}`;
    }
  } catch { /* A missing cover must not hide a usable video. */ }
  if (task.asset) {
    const video = task.asset.video;
    result.video = { bytes: video.bytes, file: video.file, width: null, height: null };
    const key = `${task.id}:${video.sha256}`;
    let size = sizeCache.get(key);
    if (!size) {
      const controller = new AbortController(); probes.add(controller);
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const file = await assetPath(directory, video.file);
        let output = '';
        const processResult = await runProcess({ executable: tools.ffprobe, args: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], cwd: directory, signal: controller.signal,
          onLine: (line) => { if (output.length < 32768) output += line; } });
        if (processResult.exitCode === 0) {
          const parsed = JSON.parse(output) as { streams?: { width?: number; height?: number }[] };
          const stream = parsed.streams?.[0];
          if (stream && Number.isInteger(stream.width) && Number.isInteger(stream.height) && stream.width! > 0 && stream.height! > 0) {
            size = { width: stream.width!, height: stream.height! }; sizeCache.set(key, size);
          }
        }
      } catch { /* Resolution is advisory; a probe failure never downgrades READY. */ }
      finally { clearTimeout(timeout); probes.delete(controller); }
    }
    if (size) Object.assign(result.video, size);
  }
  return result;
}
async function attach(id: unknown, input: unknown): Promise<DownloadTask> {
  const task = getTask(id);
  const file = text(input, 32768);
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.mp4') throw new DesktopError('INVALID_MEDIA', '请选择已下载完成的本地 .mp4 文件。');
  return engine().attachLocalMedia(task.id, file);
}
function registerIPC(): void {
  handle('omni:studio-settings', () => studio.publicSettings());
  handle('omni:save-studio-settings', input => studio.save(input));
  handle('omni:library', id => studio.library(getTask(id)));
  handle('omni:rewrite', (id, platforms) => studio.rewrite(getTask(id), platforms));
  handle('omni:save-copy', (id, platform, copy, revision) => studio.edit(getTask(id), platform, copy, revision));
  handle('omni:process', id => studio.process(getTask(id)));
  handle('omni:cancel-studio', (id, kind) => studio.cancel(getTask(id).id, kind));
  handle('omni:analytics', () => collectAnalytics(dataDirectory, engine().listTasks()));
  handle('omni:snapshot', () => ({ tasks: engine().listTasks(), proxy, version: app.getVersion(), dataDirectory }));
  handle('omni:fetch', (url) => engine().fetchMetadata(text(url), { proxy: proxy.enabled ? proxy.url : '' }));
  handle('omni:proxy', saveProxy);
  handle('omni:assets', assets);
  handle('omni:attach', attach);
  handle('omni:select-attach', async (id) => {
    const task = getTask(id);
    if (task.state !== 'AWAITING_MEDIA') throw new DesktopError('INVALID_STATE', '请先解析链接，或等待当前操作完成。');
    const result = await dialog.showOpenDialog(window!, { title: '挂载本地视频', properties: ['openFile'], filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
    return result.canceled || !result.filePaths[0] ? null : attach(task.id, result.filePaths[0]);
  });
  handle('omni:cancel', async (id) => { await engine().cancel(getTask(id).id); });
  handle('omni:open-assets', async (id) => {
    const task = getTask(id);
    if (!task.asset && !task.metadataAsset) throw new DesktopError('INVALID_STATE', '尚未生成本地素材。');
    const error = await shell.openPath(engine().getAssetDirectory(task.id));
    if (error) throw new DesktopError('OPEN_FAILED', '无法打开素材目录。');
  });
  handle('omni:copy', (input) => { clipboard.writeText(text(input, 100000)); });
  handle('omni:window', (action) => {
    if (action === 'minimize') window?.minimize();
    else if (action === 'maximize') { if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); }
    else if (action === 'close') window?.close();
    else throw new DesktopError('INVALID_INPUT', '未知窗口操作。');
  });
}
function createWindow(): void {
  window = new BrowserWindow({ width: 1240, height: 900, minWidth: 980, minHeight: 720, frame: false, roundedCorners: true, hasShadow: true,
    backgroundColor: '#18181b', show: false, title: 'OmniPost · 全播', autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  if (devURL) void window.loadURL(devURL); else void window.loadFile(rendererFile);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  void app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await mkdir(app.getPath('userData'), { recursive: true });
    await loadProxy();
    await studio.load();
    try {
      scheduler = await DownloadScheduler.create({ dataDirectory, tools, metadataTimeoutMs: 20000,
        onEvent: (event) => { if (event.type !== 'progress' && window && !window.isDestroyed()) window.webContents.send('omni:task', { kind: event.type, task: event.task }); } });
    } catch (error) { startupError = error; }
    registerIPC(); createWindow();
  }).catch(() => { dialog.showErrorBox('OmniPost 启动失败', '无法创建本地应用目录，请检查目录权限。'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    for (const probe of probes) probe.abort();
    void Promise.allSettled([studio.close(), scheduler?.close() ?? Promise.resolve()]).finally(() => app.quit());
  });
}
