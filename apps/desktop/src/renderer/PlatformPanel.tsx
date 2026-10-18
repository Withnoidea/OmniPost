import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, Upload, X } from 'lucide-react';
import type { DownloadTask, PlatformAccount, TargetPlatform, TaskLibrary } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
export const platformNames: Record<TargetPlatform, string> = { douyin: '抖音', bilibili: '哔哩哔哩', kuaishou: '快手', xiaohongshu: '小红书' };
export function AccountPanel() {
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [pending, setPending] = useState<TargetPlatform[]>([]);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; const updates = new Map<TargetPlatform, PlatformAccount>();
    const unsubscribe = api.onAccount(account => { updates.set(account.platform, account); if (alive) setAccounts(old => [...old.filter(item => item.platform !== account.platform), account]); });
    void api.accounts().then(unwrap).then(value => { if (alive) setAccounts(value.map(account => updates.get(account.platform) ?? account)); }).catch(e => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  async function connect(platform: TargetPlatform) {
    setPending(old => [...old, platform]); setError(''); setNotice('请在专属浏览器窗口中扫码或登录。');
    try { const account = unwrap(await api.connectPlatform(platform)); setAccounts(old => [...old.filter(item => item.platform !== platform), account]); setNotice(`${platformNames[platform]}已连接，登录环境已保存在本机。`); }
    catch (e) { setError(errorMessage(e)); setNotice(''); }
    finally { setPending(old => old.filter(p => p !== platform)); }
  }
  return <section className="account-section" aria-labelledby="accounts-heading">
    <div className="section-heading"><h2 id="accounts-heading">平台账号 <span>独立环境</span></h2><span className="queue-caption">扫码登录 · 本机持久化</span></div>
    <div className="account-grid">{(Object.keys(platformNames) as TargetPlatform[]).map(platform => {
      const account = accounts.find(item => item.platform === platform); const busy = pending.includes(platform) || account?.state === 'connecting';
      const connecting = busy && account?.state !== 'connected';
      return <article className="account-card surface" key={platform}><header><span className={`platform-monogram ${platform}`}>{platformNames[platform][0]}</span><h3>{platformNames[platform]}</h3></header>
        <p className={account?.state === 'connected' ? 'connected-label' : ''}>{connecting ? <Loader2 size={13} className="spin" /> : account?.state === 'connected' ? <CheckCircle2 size={13} /> : <i className="dot" />}{connecting ? '等待扫码登录' : account?.state === 'connected' ? '已连接 · Connected' : '未连接'}</p>
        <small>{account?.checkedAt ? `最近验证 ${new Date(account.checkedAt).toLocaleString()}` : '每个平台使用独立 Chromium 目录'}</small>
        <footer><button className="text-button" disabled={busy || account?.windowOpen} onClick={() => void connect(platform)}><ExternalLink size={13} />{account?.state === 'connected' ? '检查登录' : '连接 / 登录'}</button>{account?.windowOpen && <button className="text-button" onClick={() => void api.closePlatform(platform).then(unwrap).catch(e => setError(errorMessage(e)))}><X size={12} />关闭窗口</button>}</footer>
      </article>;
    })}</div>
    <p className="field-hint">“已连接”表示最近一次验证成功；发布前会再次检查。登录 Cookie 保留于独立用户目录，请勿分享 profiles 文件夹。</p>
    {notice && <p className="inline-notice" role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
export function PublishPanel({ task, onAccounts }: { task: DownloadTask | undefined; onAccounts: () => void }) {
  const [platform, setPlatform] = useState<TargetPlatform>('douyin');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [library, setLibrary] = useState<TaskLibrary | null>(null);

  useEffect(() => {
    let active = true;
    setNotice('');
    setError('');
    if (task?.id) {
      void api.library(task.id).then(unwrap).then(lib => { if (active) setLibrary(lib); }).catch(() => {});
    } else {
      setLibrary(null);
    }
    return () => { active = false; };
  }, [task?.id, busy]);

  const hasVideo = Boolean(library?.processed?.video || task?.asset?.video);
  const copy = library?.rewritten?.platforms[platform];
  const hasCopy = Boolean(copy?.title?.trim());
  const readyToPublish = Boolean(task && hasVideo && hasCopy);

  let statusHint = '';
  if (!task) statusHint = '请先在上方导入或创建一个任务素材。';
  else if (!hasVideo && !hasCopy) statusHint = `当前缺少 ${platformNames[platform]} 文案和视频文件。`;
  else if (!hasCopy) statusHint = `请先在下方“内容本地化”中生成 ${platformNames[platform]} 平台文案。`;
  else if (!hasVideo) statusHint = '文案已就绪，但尚未挂载或下载视频文件。';

  async function publish() {
    if (busy) return;
    if (!task) {
      setError('请先在上方解析链接或创建素材任务。');
      return;
    }
    if (!hasCopy) {
      setError(`请先生成 ${platformNames[platform]} 平台文案（在下方点击“一键 AI 改写”）。`);
      return;
    }
    if (!hasVideo) {
      setError('未找到可用视频文件。请点击“一键下载原视频”或挂载本地 MP4。');
      return;
    }

    setBusy(true);
    setError('');
    setNotice(`正在打开 ${platformNames[platform]} 发布窗口；必要时请扫码登录。`);
    try {
      const result = unwrap(await api.publish(task.id, platform));
      setNotice(`${result.uploaded ? '已自动挂载' + (library?.processed ? '处理后视频' : '原始视频') + '，等待平台上传完成。' : ''}${result.filled.length ? '已预填：' + result.filled.join('、') + '。' : ''}${result.warnings.join(' ')}`);
    } catch (e) {
      setNotice('');
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return <div className="publish-panel">
    <div className="publish-controls">
      <select aria-label="发布目标平台" disabled={busy} value={platform} onChange={e => { setPlatform(e.target.value as TargetPlatform); setError(''); }}>
        {Object.entries(platformNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
      <button
        className={`primary-button ${readyToPublish ? 'highlight' : ''}`}
        disabled={busy}
        title={statusHint || `一键发布到 ${platformNames[platform]}`}
        onClick={() => void publish()}
      >
        {busy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
        发布到平台
      </button>
      <button className="text-button" onClick={onAccounts}>管理账号</button>
    </div>
    <small>{readyToPublish ? '文案与视频均已就绪，点击即可唤起平台自动化预填。' : statusHint || '优先使用 FFmpeg 处理后视频，未处理时平滑直发原始素材；最终由你确认发布。'}</small>
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}