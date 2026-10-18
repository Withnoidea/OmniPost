import { ManualDialog } from './ManualDialog.js';
import { VerificationPanel } from './VerificationPanel.js';
import { SettingsDialog } from './SettingsDialog.js';
import { StudioPanel } from './StudioPanel.js';
import { Analytics } from './Analytics.js';
import { currentTheme, applyTheme } from './theme.js';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, CheckCheck, CheckCircle2, ChevronDown, CircleHelp, Clapperboard, Clock3, Copy, ExternalLink, FileVideo2, FolderOpen, HardDrive, Image, Layers3, Link2, Loader2, Maximize2, Minus, Moon, Plus, Sun, Radio, Settings2, ShieldCheck, Trash2, Wifi, X } from 'lucide-react';
import type { DownloadTask, Reply, Snapshot, TaskAssets } from '../shared/contracts.js';
import { bytes, duration, isBusy, isReady, metadataOf, proxyLabel, stateLabels, upsert } from './model.js';
import { api, unwrap, errorMessage } from './bridge.js';

type State = { tasks: DownloadTask[]; selected: string | null };
type Action =
  | { type: 'tasks'; tasks: DownloadTask[]; event?: boolean }
  | { type: 'select'; id: string }
  | { type: 'remove'; id: string };

function reducer(state: State, action: Action): State {
  if (action.type === 'select') return { ...state, selected: action.id };
  if (action.type === 'remove') {
    const tasks = state.tasks.filter(t => t.id !== action.id);
    const selected = state.selected === action.id ? (tasks[0]?.id ?? null) : state.selected;
    return { tasks, selected };
  }
  const tasks = upsert(state.tasks, action.tasks);
  const first = action.tasks[0];
  const newTask = action.event && first && !state.tasks.some(t => t.id === first.id);
  return { tasks, selected: newTask ? first.id : state.selected ?? tasks[0]?.id ?? null };
}

export default function App() {
  const [theme, setTheme] = useState(currentTheme);
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
  }
  const [state, dispatch] = useReducer(reducer, { tasks: [], selected: null });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [url, setUrl] = useState('');
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [assets, setAssets] = useState<TaskAssets | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<'studio' | 'analytics'>('studio');
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [manual, setManual] = useState<DownloadTask | 'new' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<HTMLElement>(null);
  const dragDepth = useRef(0);
  const attachmentLock = useRef(false);
  const task = state.tasks.find(t => t.id === state.selected);
  const meta = metadataOf(task);
  const ready = isReady(task);
  const busy = isBusy(task);
  const mounting = task?.state === 'attaching';
  const selecting = Boolean(task) && attachingId === task?.id && !mounting && !ready;
  const canAttach = task?.state === 'AWAITING_MEDIA' && !mounting && !selecting;
  const proxy = snapshot?.proxy ?? { enabled: false, url: '', persisted: true };
  const runningCount = state.tasks.filter(isBusy).length;
  const elapsed = task ? Math.max(0, Math.floor(((busy ? now : Date.parse(task.updatedAt)) - Date.parse(task.createdAt)) / 1000)) : 0;
  useEffect(() => {
    if (!api) { setError('请使用 npm run dev 启动桌面窗口，此页面需要安全的 Electron 桥接。'); return; }
    let alive = true;
    const unsubscribe = api.onTask(event => { if (alive) dispatch({ type: 'tasks', tasks: [event.task], event: true }); });
    void api.snapshot().then(unwrap).then(value => { if (alive) { setSnapshot(value); dispatch({ type: 'tasks', tasks: value.tasks }); } }).catch(e => { if (alive) setError(errorMessage(e)); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const prevent = (event: globalThis.DragEvent): void => event.preventDefault();
    window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
    return () => { alive = false; unsubscribe(); clearInterval(timer); window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);
  useEffect(() => {
    let alive = true; setAssets(null); setExpanded(false); setDragging(false); dragDepth.current = 0;
    if (!task?.asset && !task?.metadataAsset) { setAssetsLoading(false); return; }
    setAssetsLoading(true);
    void api.assets(task.id).then(unwrap).then(value => { if (alive) setAssets(value); }).catch(e => { if (alive) setError(errorMessage(e)); }).finally(() => { if (alive) setAssetsLoading(false); });
    return () => { alive = false; };
  }, [task?.id, task?.asset?.video.sha256, task?.metadataAsset?.thumbnail.sha256]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const [downloading, setDownloading] = useState(false);
  async function downloadVideo(source = url): Promise<void> {
    if (downloading || !source.trim()) return;
    setDownloading(true); setError(''); setNow(Date.now());
    try {
      const result = unwrap(await api.download(source.trim()));
      dispatch({ type: 'tasks', tasks: [result] });
      if (!result.error) setNotice('视频与元数据已成功下载并落盘');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDownloading(false);
    }
  }
  async function deleteTask(id: string): Promise<void> {
    if (deletingBusy) return;
    setDeletingBusy(true);
    setError('');
    setAssets(null);
    dispatch({ type: 'remove', id });
    setDeletingId(null);
    try {
      unwrap(await api.deleteTask(id));
      setNotice('素材及本地缓存文件已彻底删除');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeletingBusy(false);
    }
  }
  async function attach(file?: File): Promise<void> {
    if (!task || !canAttach || attachmentLock.current) return;
    if (file && !/\.mp4$/i.test(file.name)) { setError('请选择已下载完成的 .mp4 视频，不支持临时下载文件。'); return; }
    attachmentLock.current = true; setAttachingId(task.id); setError('');
    try {
      const result = unwrap(await (file ? api.attachDroppedFile(task.id, file) : api.selectAndAttach(task.id)));
      if (result) { dispatch({ type: 'tasks', tasks: [result] }); if (isReady(result)) setNotice('视频已校验并复制到素材库，原文件未修改'); }
    } catch (e) { setError(errorMessage(e)); } finally { attachmentLock.current = false; setAttachingId(null); }
  }
  async function action(operation: () => Promise<Reply<unknown>>, success?: string): Promise<void> {
    try { unwrap(await operation()); if (success) setNotice(success); } catch (e) { setError(errorMessage(e)); }
  }
  function drop(event: DragEvent): void {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (!canAttach) return;
    if (event.dataTransfer.files.length !== 1) { setError('每个任务请挂载一个 .mp4 文件。'); return; }
    void attach(event.dataTransfer.files[0]);
  }
  const log = task?.error ? `${task.error.code} · ${task.error.message}` : ready ? '校验完成 · 视频与元数据均已持久化' : task?.state === 'AWAITING_MEDIA' ? '元数据与封面已落盘 · 等待本地视频' : task?.state === 'attaching' ? '正在复制视频并校验 SHA-256，请勿移除源文件' : busy ? 'yt-dlp 正在处理 · 元数据模式不会下载视频' : '素材引擎就绪 · 从一个视频链接开始';
  return <div className="desktop-shell">
    <header className="titlebar"><div className="titlebar-brand"><AudioLines size={17} /><span>OmniPost</span><span className="titlebar-divider" /><span className="titlebar-sub">全播桌面端</span></div><div className="titlebar-right"><button className="titlebar-proxy" disabled={!snapshot} onClick={() => setSettings(true)} title="配置代理（非连通性检测）"><i className={proxy.enabled ? 'dot amber' : 'dot'} />{proxyLabel(proxy.enabled, proxy.url)}<ChevronDown size={12} /></button><button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={theme === 'light' ? '切换到夜间模式' : '切换到日间模式'} title={theme === 'light' ? '切换到夜间模式' : '切换到日间模式'}>{theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}</button><span className="window-divider" /><button className="window-button" aria-label="最小化" onClick={() => void action(() => api.windowControl('minimize'))}><Minus size={16} /></button><button className="window-button" aria-label="最大化或还原" onClick={() => void action(() => api.windowControl('maximize'))}><Maximize2 size={13} /></button><button className="window-button close-button" aria-label="关闭窗口" onClick={() => void action(() => api.windowControl('close'))}><X size={17} /></button></div></header>
    <div className="app-body"><aside className="sidebar">
      <div className="brand-lockup"><div className="brand-symbol"><AudioLines size={27} strokeWidth={1.7} /></div><div><strong>OmniPost<span>全播</span></strong><small>让内容，跨越边界。</small></div></div>
      <p className="nav-caption">工作空间</p><nav aria-label="主导航"><button className={`nav-item ${page === 'studio' ? 'active' : ''}`} aria-current={page === 'studio' ? 'page' : undefined} onClick={() => setPage('studio')}><Clapperboard size={17} />工作台 <span className="nav-arrow">Studio</span></button><button className={`nav-item ${page === 'analytics' ? 'active' : ''}`} aria-current={page === 'analytics' ? 'page' : undefined} onClick={() => setPage('analytics')}><Layers3 size={17} />监控中心 <span className="nav-arrow">Analytics</span></button><button className="nav-item" onClick={() => setSettings(true)}><Settings2 size={17} />全局设置 <span className="nav-arrow">Settings</span></button></nav>
      <div className="pipeline-guide"><div className="guide-heading">你的创作流水线</div><div className="guide-step current"><span>01</span><div>解析与素材<small>保留灵感，也保留原始素材</small></div></div><div className="guide-line" /><div className="guide-step"><span>02</span><div>AI 文案本地化<small>四个平台，各有表达</small></div></div><div className="guide-line" /><div className="guide-step"><span>03</span><div>FFmpeg 轻量处理<small>原片保留，随时重来</small></div></div></div>
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={16} /><span>本地优先，素材由你掌控</span></div><button className="nav-item" disabled={!snapshot} onClick={() => setSettings(true)}><Settings2 size={17} />代理设置</button><button className="nav-item" onClick={() => setHelp(!help)} aria-expanded={help}><CircleHelp size={17} />使用指南<span className="version">v{snapshot?.version ?? '0.1.0'}</span></button></div>
    </aside><main className="workspace">{page === 'analytics' && <Analytics />}<div className="workspace-content" hidden={page !== 'studio'}>
      <div className="page-heading"><div><div className="eyebrow"><span /> YOUR CONTENT, CONNECTED</div><h1>素材工作台<span className="heading-dot">.</span></h1><p>从链接或本地素材开始，为下一次创作做好准备。</p></div><div className="local-badge"><HardDrive size={14} />本地素材库</div></div>
      {help && <section className="help-panel"><button className="icon-button" aria-label="关闭使用指南" onClick={() => setHelp(false)}><X size={16} /></button><strong>链接 → 元数据 → 本地视频</strong><p>粘贴 YouTube / TikTok 单视频链接，仅提取封面与元数据。用 IDM 等工具下载已获授权的视频，再将 .mp4 拖入挂载区。所有素材本地保存，重启后可继续。</p><code>{snapshot?.dataDirectory}</code></section>}
      <form className={`composer ${downloading ? 'is-working' : ''}`} onSubmit={e => { e.preventDefault(); void downloadVideo(); }}>
        <label className="composer-label" htmlFor="source-url"><Link2 size={15} />导入视频链接</label><div className="composer-input-row"><span className="composer-link-icon" aria-hidden="true"><Link2 size={18} /></span><input id="source-url" ref={input} value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴视频链接（YouTube / TikTok / 抖音 / 哔哩哔哩 / 快手）…" spellCheck={false} autoComplete="off" disabled={!snapshot} /><button type="button" className="clear-input icon-button" aria-label="清空链接" disabled={!url || downloading} onClick={() => { setUrl(''); input.current?.focus(); }}><X size={15} /></button><button type="submit" className="primary-button fetch-button" disabled={downloading || !url.trim() || !snapshot}>{downloading ? <Loader2 size={16} className="spin" /> : <ArrowDownToLine size={16} />}<span>{downloading ? '正在下载' : '下载并导入'}</span>{!downloading && <ArrowRight size={15} />}</button></div>
        <div className="composer-footer"><div className="composer-hint"><span className="platform-mark youtube-mark">▶</span><span>YouTube</span><span className="hint-divider">/</span><span className="platform-mark tiktok-mark">♪</span><span>TikTok</span><span className="hint-divider">/</span><span>抖音</span><span className="hint-divider">/</span><span>B站</span><span className="hint-divider">/</span><span>快手</span><span className="only-meta">自动下载无水印原片、高清封面与元数据</span></div><div className="composer-actions"><button type="button" className="text-button" disabled={!snapshot} onClick={() => setManual('new')}><Plus size={13} />手动创建</button><button type="button" className="proxy-chip" disabled={!snapshot} onClick={() => setSettings(true)}><Wifi size={13} /><span>{proxyLabel(proxy.enabled, proxy.url)}</span><ChevronDown size={12} /></button></div></div>
      </form><div className="under-composer"><ShieldCheck size={12} /><span>本地优先落盘 · 原片持久化归档 · 所见即所发</span></div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
      <section className="material-section" aria-labelledby="material-heading"><div className="section-heading"><div className="section-title-wrap"><h2 id="material-heading">当前素材 <span>01 / 素材准备</span></h2>{task && <span className={`status-badge ${ready ? 'ready' : task.error ? 'failed' : ''}`}><i className="dot" />{task.error?.code === 'AUTH_REQUIRED' ? '需要人工验证' : task.state === 'AWAITING_MEDIA' ? 'AWAITING_MEDIA · 等待视频挂载' : ready ? 'READY · 媒体已就绪' : stateLabels[task.state]}</span>}</div>{task && <div className="material-heading-actions">{deletingId === task.id ? <div className="delete-confirm-bar" role="alertdialog" aria-label="确认清空素材"><span className="confirm-text">确定删除此素材及本地所有文件？</span><button type="button" className="danger-button" disabled={deletingBusy} onClick={() => void deleteTask(task.id)}>{deletingBusy ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}<span>确认清空</span></button><button type="button" className="text-button" disabled={deletingBusy} onClick={() => setDeletingId(null)}>取消</button></div> : <button type="button" className="secondary-button delete-task-btn" disabled={busy || deletingBusy} onClick={() => setDeletingId(task.id)} title="清空当前素材并彻底删除本地文件"><Trash2 size={13} /><span>清空当前素材</span></button>}</div>}</div><div className="material-grid">
        <article className={`metadata-card surface ${meta ? 'reveal' : 'empty-metadata'}`}>
          {meta ? <><div className="cover-wrap">{assets?.cover ? <img src={assets.cover} alt={`${meta.title} 的视频封面`} /> : <div className="cover-fallback">{assetsLoading ? <Loader2 className="spin" size={22} /> : <Image size={30} />}<span>{assetsLoading ? '正在读取封面' : '封面暂不可预览'}</span></div>}<span className="source-label">{task?.platform === 'local' ? '本地素材' : task?.platform === 'youtube' ? 'YouTube' : 'TikTok'}</span><span className="duration-chip">{duration(meta.durationSeconds)}</span></div>
          <div className="metadata-content"><div className="metadata-kicker">原始素材 <span>ORIGINAL</span></div><div className="video-title-row"><h3>{meta.title}</h3><button className="icon-button" title="复制原标题" aria-label="复制原标题" onClick={() => void action(() => api.copyText(meta.title), '原标题已复制')}><Copy size={15} /></button></div><div className="metadata-facts"><span>{meta.uploader || meta.channel || '未知作者'}</span><i />{meta.uploadDate ? <span>{meta.uploadDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3')}</span> : <span>日期未知</span>}{meta.language && <><i /><span>{meta.language.toUpperCase()}</span></>}</div>
          <p className={`description ${expanded ? 'expanded' : ''}`}>{meta.description || '该视频没有提供描述。'}</p>{meta.description.length > 95 && <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起简介' : '展开简介'}<ChevronDown size={12} className={expanded ? 'rotate' : ''} /></button>}
          <div className="tags">{meta.tags.slice(0, 6).map((tag, i) => <span key={`${tag}-${i}`}>#{tag.replace(/^#/, '')}</span>)}{meta.tags.length > 6 && <span title={meta.tags.slice(6).join(' · ')}>+{meta.tags.length - 6}</span>}{!meta.tags.length && <span className="no-tags">原视频未提供话题</span>}</div><div className="metadata-saved"><CheckCheck size={13} />media.info.json 已保存{meta.subtitleLanguages.length > 0 && <span>{meta.subtitleLanguages.length} 种字幕</span>}</div></div></> : <><div className="empty-art"><div className="art-grid" /><div className="art-frame back" /><div className="art-frame"><Image size={34} strokeWidth={1.2} /><span /><span /></div><span className="art-spark"><Plus size={17} /></span></div><h3>{busy ? '正在读取视频信息' : task?.error ? '这次解析未完成' : '灵感，从这里开始'}</h3><p>{busy ? '仅抓取标题、描述与封面，无需等待视频下载' : task?.error ? '任务记录已保留，可重新解析或手动补全继续创作' : '解析链接后，视频封面与原始信息将在这里呈现'}</p><div className="empty-foot"><span className={busy ? 'pulse-dot' : 'dot'} />{busy ? '连接源站 · 最长约 20 秒' : '支持 YouTube / TikTok 单视频'}</div></>}
        </article><div className="attachment-column"><div className={`dropzone ${dragging ? 'dragging' : ''} ${ready ? 'is-ready' : ''} ${mounting ? 'is-mounting' : ''} ${!canAttach && !ready && !mounting ? 'inactive' : ''}`} onDragEnter={e => { e.preventDefault(); dragDepth.current++; if (canAttach) setDragging(true); }} onDragLeave={e => { e.preventDefault(); if (--dragDepth.current <= 0) setDragging(false); }} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'; }} onDrop={drop}>
          <div className="dropzone-top"><span>本地视频</span><span className="format-badge">.MP4</span></div><div className="dropzone-body" aria-live="polite">{ready ? <><div className="drop-icon ready-icon"><CheckCircle2 size={29} strokeWidth={1.5} /></div><span className="ready-overline">READY</span><h3>媒体已就绪</h3><p>视频已安全挂载，可以继续下一步</p><div className="video-spec"><span><HardDrive size={13} />{assets?.video ? bytes(assets.video.bytes) : task?.asset ? bytes(task.asset.video.bytes) : '读取中'}</span><i />{assetsLoading ? '读取分辨率…' : assets?.video?.width ? `${assets.video.width} × ${assets.video.height}` : '分辨率暂不可用'}</div><div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}><button className="secondary-button" onClick={() => void action(() => api.openAssets(task!.id))}><FolderOpen size={15} />打开素材目录<ExternalLink size={12} /></button><button type="button" className="text-button delete-task-btn" disabled={deletingBusy} onClick={() => setDeletingId(task!.id)} title="清空当前素材"><Trash2 size={13} />清空此素材</button></div></> : mounting || selecting ? <><div className="drop-icon"><Loader2 size={27} className="spin" /></div><h3>{selecting ? '等待选择本地视频' : '校验并挂载视频'}</h3><p>{selecting ? '在系统文件选择器中选取一个 .mp4 文件' : '复制到素材库 · 探测视频 · 校验完整性'}</p><div className="indeterminate"><span /></div><small>原始文件始终保留，请稍候</small></> : <><div className="drop-icon"><ArrowDownToLine size={27} strokeWidth={1.5} /></div><h3>{dragging ? '松开，挂载这段视频' : '让灵感，准备就绪'}</h3><p>将外部 / IDM 下载的无水印 .mp4<br />文件拖拽至此，或点击浏览</p><button className="secondary-button browse-button" disabled={!canAttach} onClick={() => void attach()}><FolderOpen size={15} />浏览本地文件</button>{Boolean(task?.sourceUrl && canAttach) && <button className="primary-button" style={{ marginTop: '8px', fontSize: '11px', padding: '6px 14px' }} disabled={downloading} onClick={() => { if (task?.sourceUrl) void downloadVideo(task.sourceUrl); }}>{downloading ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}一键下载原视频</button>}<small>{canAttach ? '复制并校验，原文件不会被修改' : '也可点击手动录入，直接创建素材'}</small></>}</div><div className="dropzone-bottom"><ShieldCheck size={13} /><span>{ready ? '视频、封面与元数据已保存在本地' : '大文件交给下载工具，素材交给 OmniPost'}</span></div>
        </div></div>
      </div>{task?.error?.code === 'AUTH_REQUIRED' && <VerificationPanel key={task.id} task={task} onTask={next => dispatch({ type: 'tasks', tasks: [next], event: true })} />}{task?.error && <div className="task-error" role="alert"><span><strong>{task.error.code}</strong>{task.error.message}</span>{!busy && Boolean(task.sourceUrl) && task.state !== 'AWAITING_MEDIA' && <button className="text-button" disabled={downloading} onClick={() => { setUrl(task.sourceUrl); void downloadVideo(task.sourceUrl); }}>重新下载<ArrowRight size={13} /></button>}</div>}</section>
      <div className="manual-entry"><button className="secondary-button" onClick={() => setManual('new')}><Plus size={15} />手动录入 / 无链接创建</button>{task && <button className="text-button" disabled={busy} onClick={() => setManual(task)}>手动补全当前素材<ArrowRight size={13} /></button>}<span>解析失败也不必停下，原任务始终保留。</span></div><StudioPanel task={task} onSettings={() => setSettings(true)} onAccounts={() => setPage('analytics')} /><section className="queue-section" ref={queue} aria-labelledby="queue-heading"><div className="section-heading"><h2 id="queue-heading">任务队列 <span>{String(state.tasks.length).padStart(2, '0')}</span></h2><span className="queue-caption">{runningCount ? `${runningCount} 个任务正在处理` : '所有记录仅存储于本机'}</span></div><div className="queue-table surface"><div className="queue-header"><span>素材 / 任务</span><span>来源</span><span>状态</span><span>耗时</span><span style={{ textAlign: 'right' }}>操作</span></div><div className="queue-rows">{state.tasks.length ? state.tasks.map(item => <div key={item.id} className={`queue-row ${state.selected === item.id ? 'selected' : ''}`} role="button" tabIndex={0} aria-pressed={state.selected === item.id} onClick={() => dispatch({ type: 'select', id: item.id })} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dispatch({ type: 'select', id: item.id }); } }}><span className="queue-name"><span className={`queue-icon ${isReady(item) ? 'ready' : ''}`}>{isBusy(item) ? <Loader2 className="spin" size={16} /> : <FileVideo2 size={16} />}</span><span><strong>{metadataOf(item)?.title ?? item.sourceUrl}</strong><small>{item.id.slice(0, 8)}</small></span></span><span className="queue-source">{item.platform === 'local' ? '本地' : item.platform === 'youtube' ? 'YouTube' : 'TikTok'}</span><span className={`queue-state ${isReady(item) ? 'ready' : item.error ? 'failed' : ''}`}><i className="dot" />{item.error?.code === 'AUTH_REQUIRED' ? '需要人工验证' : stateLabels[item.state]}</span><span className="queue-time">{Math.max(0, Math.floor(((isBusy(item) ? now : Date.parse(item.updatedAt)) - Date.parse(item.createdAt)) / 1000))}s</span><span className="queue-actions" onClick={e => e.stopPropagation()}>{deletingId === item.id ? <button type="button" className="danger-button" style={{ padding: '2px 6px', fontSize: '10px' }} disabled={deletingBusy} onClick={() => void deleteTask(item.id)} title="确认删除">{deletingBusy ? <Loader2 size={10} className="spin" /> : <Trash2 size={10} />} 删</button> : <button type="button" className="icon-button queue-delete-btn" title="删除素材及本地文件" aria-label={`删除 ${item.id.slice(0, 8)}`} onClick={() => setDeletingId(item.id)}><Trash2 size={13} /></button>}</span></div>) : <div className="queue-empty"><Layers3 size={16} />还没有任务，粘贴链接创建你的第一份素材。<span>本地自动保存</span></div>}</div></div></section>
      <footer className="workspace-footer"><span>一个工作台，连接每一份好内容。</span><span>STUDIO <i /> LOCAL-FIRST</span></footer>
    </div></main></div>
    <footer className="statusbar"><div className="status-log" role="status"><Radio size={13} className={busy ? 'amber-text' : ''} /><span>{notice || log}</span></div><div className="statusbar-right">{busy && task && <button onClick={() => void action(() => api.cancel(task.id))}>取消任务</button>}{task ? <><button className="task-id" title={task.id} onClick={() => void action(() => api.copyText(task.id), '任务 ID 已复制')}>ID {task.id.slice(0, 8)}<Copy size={11} /></button><span><Clock3 size={11} />{elapsed}s</span></> : <span><i className="dot" />{snapshot ? '引擎已就绪' : '引擎连接中'}</span>}</div></footer>
    {manual && <ManualDialog {...(manual === 'new' ? {} : { task: manual })} onClose={() => setManual(null)} onSaved={next => { dispatch({ type: 'tasks', tasks: [next], event: true }); setNotice(next.error ? '素材校验失败，可继续修改并重试' : next.state === 'READY' ? '手动素材已就绪，可以继续改写与加工' : '文字已保存，挂载视频后即可继续'); }} />}{settings && <SettingsDialog proxy={proxy} onClose={() => setSettings(false)} onSave={value => { setSnapshot(old => old ? { ...old, proxy: value } : old); setNotice(value.persisted ? '全局配置已保存，仅影响新任务' : '代理仅用于本次会话，凭据未写入磁盘'); }} />}
  </div>;
}
