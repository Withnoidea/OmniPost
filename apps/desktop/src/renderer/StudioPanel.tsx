import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, CheckCircle2, Copy, ExternalLink, Film, Loader2, RotateCcw, Save, Settings2, Sparkles, Square, Upload, WandSparkles } from 'lucide-react';
import type { DownloadTask, LocalizedCopy, TargetPlatform, TaskLibrary, StudioEvent } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
import { bytes } from './model.js';
import { planRewrite, REWRITE_PLATFORMS } from './rewrite-plan.js';
import type { RewriteProgress } from '../../../../packages/core/src/rewriter/types.js';
export const platformNames: Record<TargetPlatform, string> = { xiaohongshu: '小红书', bilibili: 'B站', douyin: '抖音', kuaishou: '快手' };
const platforms = REWRITE_PLATFORMS;
const hints: Record<TargetPlatform, string> = { xiaohongshu: '双段标题 · Emoji 排版 · 痛点与种草 · 3–5 个精选话题', bilibili: '好奇心标题 · 视频梗概 · 互动引导 · 推荐投递分区', douyin: '前 3 秒钩子 · 极简标题 · 精选话题', kuaishou: '亲切口语 · 开场钩子 · 真实生活感' };
export function StudioPanel({ task, onSettings, onAccounts }: { task: DownloadTask | undefined; onSettings: () => void; onAccounts?: () => void }) {
  const [platform, setPlatform] = useState<TargetPlatform>('xiaohongshu');
  const [libraries, setLibraries] = useState<Record<string, TaskLibrary>>({});
  const [drafts, setDrafts] = useState<Record<string, LocalizedCopy>>({});
  const [running, setRunning] = useState<Record<string, string>>({});
  const [percent, setPercent] = useState<Record<string, number>>({});
  const [progress, setProgress] = useState<Record<string, RewriteProgress | undefined>>({});
  const [phases, setPhases] = useState<Record<string, RewriteProgress['phase']>>({});
  const [confirmation, setConfirmation] = useState<{ taskId: string; revision: string } | null>(null);
  const generating = useRef(new Set<string>());
  const libraryReads = useRef<Record<string, number>>({});
  const activityVersions = useRef<Record<string, number>>({});
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmation) confirmButton.current?.focus(); }, [confirmation]);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [saving, setSaving] = useState(false); const [publishing, setPublishing] = useState(false);
  const selected = useRef(task?.id); selected.current = task?.id;
  const id = task?.id; const library = id ? libraries[id] : undefined;
  const key = `${id}:${platform}`; const draft = drafts[key]; const saved = library?.rewritten?.platforms[platform]; const copy = draft ?? saved;
  const rewriting = Boolean(id && running[`${id}:rewrite`]); const processing = Boolean(id && running[`${id}:process`]);
  const taskDrafts = Object.fromEntries(platforms.filter(p => drafts[`${id}:${p}`]).map(p => [p, drafts[`${id}:${p}`]!])) as Partial<Record<TargetPlatform, LocalizedCopy>>;
  const dirty = Object.keys(taskDrafts).length > 0;
  const allPlan = planRewrite(true, platform, library?.rewritten?.platforms ?? {}, taskDrafts);
  const rewriteProgress = id ? progress[id] : undefined;
  const available = Boolean(task?.asset || task?.metadataAsset); const processed = library?.processed;
  const hasVideo = Boolean(library?.processed?.video || task?.asset?.video);
  const hasCopy = Boolean(draft?.title?.trim() || saved?.title?.trim());
  const readyToPublish = Boolean(task && hasVideo && hasCopy);
  let statusHint = '';
  if (!task) statusHint = '请先选择或创建一个素材任务';
  else if (!hasVideo && !hasCopy) statusHint = `请先生成 ${platformNames[platform]} 平台文案并准备好视频素材`;
  else if (!hasCopy) statusHint = `请先点击“一键 AI 改写”生成 ${platformNames[platform]} 平台文案`;
  else if (!hasVideo) statusHint = '文案已就绪，但未找到可用视频（请挂载或下载视频）';
  else statusHint = `一键发布到 ${platformNames[platform]}`;
  const load = useCallback(async (taskId: string, syncRunning = true) => {
    const activityVersion = activityVersions.current[taskId];
    const sequence = (libraryReads.current[taskId] ?? 0) + 1; libraryReads.current[taskId] = sequence;
    try {
      const value = unwrap(await api.library(taskId));
      if (libraryReads.current[taskId] !== sequence) return; setLibraries(old => ({ ...old, [taskId]: value }));
      // A snapshot requested before a progress/settled event must not restore stale activity.
      if (syncRunning && activityVersions.current[taskId] === activityVersion) setRunning(old => ({ ...old, [`${taskId}:rewrite`]: value.active.includes('rewrite') ? old[`${taskId}:rewrite`] || '正在改写' : generating.current.has(taskId) ? old[`${taskId}:rewrite`] || '' : '', [`${taskId}:process`]: value.active.includes('process') ? old[`${taskId}:process`] || '正在处理' : '' }));
    } catch (e) { if (selected.current === taskId) setError(errorMessage(e)); }
  }, []);
  useEffect(() => { setError(''); setNotice(''); setConfirmation(null); if (id && available) void load(id); }, [id, available, load]);
  useEffect(() => api.onStudio((event: StudioEvent) => {
    const eventTask = event.kind === 'settled' ? event.taskId : event.progress.taskId;
    activityVersions.current[eventTask] = (activityVersions.current[eventTask] ?? 0) + 1;
    if (event.kind === 'settled') { setRunning(old => ({ ...old, [`${event.taskId}:${event.operation}`]: '' })); void load(event.taskId); }
    else if (event.kind === 'process') { setPercent(old => ({ ...old, [event.progress.taskId]: event.progress.percent })); setRunning(old => ({ ...old, [`${event.progress.taskId}:process`]: event.progress.phase })); }
    else {
      const value = event.progress;
      setProgress(old => ({ ...old, [value.taskId]: value }));
      setPhases(old => ({ ...old, [`${value.taskId}:${value.platform}`]: value.phase }));
      setRunning(old => ({ ...old, [`${value.taskId}:rewrite`]: `${platformNames[value.platform]} · ${value.phase === 'started' ? '正在生成' : value.phase === 'saved' ? '已保存' : '失败'} · ${value.completed}/${value.total}` }));
      // Each platform becomes readable as soon as its atomic save completes.
      if (value.phase === 'saved') void load(value.taskId, false);
    }
  }), [load]);
  async function generate(all: boolean, confirmed = false): Promise<void> {
    if (!id || rewriting || saving || generating.current.has(id)) return;
    const current = id; generating.current.add(current); setError(''); setNotice('');
    setRunning(old => ({ ...old, [`${current}:rewrite`]: '检查已有文案…' }));
    try {
      // Re-read disk before planning; do not overwrite a result saved since the last UI refresh.
      const sequence = (libraryReads.current[current] ?? 0) + 1; libraryReads.current[current] = sequence;
      const latest = unwrap(await api.library(current));
      if (libraryReads.current[current] === sequence) setLibraries(old => ({ ...old, [current]: latest }));
      if (selected.current !== current) return;
      const plan = planRewrite(all, platform, latest.rewritten?.platforms ?? {}, taskDrafts);
      if (plan.blocked) { setError('请先保存或还原待覆盖平台的微调；补齐其他平台不会影响草稿。'); return; }
      if (plan.confirm && (!confirmed || confirmation?.taskId !== current || confirmation.revision !== latest.rewritten?.updatedAt)) {
        setConfirmation({ taskId: current, revision: latest.rewritten?.updatedAt ?? '' }); return;
      }
      setConfirmation(null);
      setProgress(old => ({ ...old, [current]: undefined }));
      setPhases(old => Object.fromEntries(Object.entries(old).filter(([k]) => !k.startsWith(current + ':'))));
      setRunning(old => ({ ...old, [`${current}:rewrite`]: `准备生成 ${plan.targets.length} 个平台…` }));
      const result = unwrap(await api.rewrite(current, plan.targets, plan.mode));
      if (selected.current === current) {
        if (result.state !== 'completed') setError(Object.values(result.errors).map(e => e?.message).join('；') || '改写已取消，已保存的平台文案保留。');
        else setNotice(plan.mode === 'missing' ? '缺失平台已补齐，已有文案与微调保持不变。' : '文案已原子保存至 rewritten.json');
      }
      await load(current, false);
    } catch (e) { if (selected.current === current) setError(errorMessage(e)); }
    finally { activityVersions.current[current] = (activityVersions.current[current] ?? 0) + 1; generating.current.delete(current); setRunning(old => ({ ...old, [`${current}:rewrite`]: '' })); }
  }
  async function process(): Promise<void> {
    if (!id || processing) return; const current = id; activityVersions.current[current] = (activityVersions.current[current] ?? 0) + 1; setError(''); setNotice(''); setPercent(old => ({ ...old, [current]: 0 })); setRunning(old => ({ ...old, [`${current}:process`]: '读取视频…' }));
    try { const result = unwrap(await api.processMedia(current)); setLibraries(old => ({ ...old, [current]: { rewritten: old[current]?.rewritten ?? null, active: [], processed: result } })); if (selected.current === current) setNotice('处理完成 · processed.mp4 已落盘，原视频保留'); }
    catch (e) { if (selected.current === current) setError(errorMessage(e)); }
    finally { activityVersions.current[current] = (activityVersions.current[current] ?? 0) + 1; setRunning(old => ({ ...old, [`${current}:process`]: '' })); }
  }
  function update(field: keyof LocalizedCopy, value: string): void {
    if (!copy) return;
    setDrafts(old => ({ ...old, [key]: { ...copy, [field]: field === 'tags' ? value.split(/[,，]/).map(t => t.trim().replace(/^#/, '')) : value } }));
  }
  async function save(): Promise<void> {
    if (!id || !draft || !library?.rewritten) return; const current = id; const draftKey = key;
    setSaving(true); setError('');
    try {
      const result = unwrap(await api.saveCopy(current, platform, draft, library.rewritten.updatedAt));
      setLibraries(old => ({ ...old, [current]: { ...old[current]!, rewritten: result } }));
      setDrafts(old => { const next = { ...old }; delete next[draftKey]; return next; }); setNotice('人工微调已保存到本地');
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }
  async function publishCurrentPlatform(): Promise<void> {
    if (publishing || rewriting || processing) return;
    if (!id || !task) {
      setError('请先在上方解析或创建素材任务。');
      return;
    }
    if (!hasCopy) {
      setError(`请先点击上方“一键 AI 改写”生成 ${platformNames[platform]} 平台文案。`);
      return;
    }
    if (!hasVideo) {
      setError('未找到可用视频文件。请点击上方“一键下载原视频”或挂载本地 MP4。');
      return;
    }
    setPublishing(true); setError(''); setNotice(`正在打开 ${platformNames[platform]} 发布窗口…`);
    try {
      const result = unwrap(await api.publish(id, platform));
      setNotice(`已打开发布窗口：${result.uploaded ? '已自动挂载' + (library?.processed ? '处理后视频' : '原始视频') + '，' : ''}${result.filled.length ? '已预填：' + result.filled.join('、') + '。' : ''}${result.warnings.join(' ')}`);
    } catch (e) {
      setNotice('');
      setError(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  }
  async function copyText(): Promise<void> {
    if (!copy) return;
    try { const tags = copy.tags.map(t => `#${t}`).join(' '); unwrap(await api.copyText([copy.title, copy.hook, copy.body, ...(copy.body.endsWith(tags) ? [] : [tags]), copy.category ? `推荐分区：${copy.category}` : ''].filter(Boolean).join('\n\n'))); setNotice('当前文案已复制'); } catch (e) { setError(errorMessage(e)); }
  }
  async function cancel(kind: 'rewrite' | 'process'): Promise<void> { if (!id) return; try { unwrap(await api.cancelStudio(id, kind)); } catch (e) { setError(errorMessage(e)); } }
  return <section className="studio-stage" aria-labelledby="localize-heading">
    <div className="section-heading"><h2 id="localize-heading">内容本地化与发布 <span>03 — 04</span></h2><div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>{onAccounts && <button className="text-button" onClick={onAccounts}><ExternalLink size={13} />平台账号管理</button>}<button className="text-button" onClick={onSettings}><Settings2 size={13} />模型与处理参数</button></div></div>
    <div className="rewrite-card surface">
      <header className="stage-header"><div><span className="eyebrow">WRITE FOR YOUR AUDIENCE</span><h3><Sparkles size={19} />换一种表达，让内容被听见。</h3></div><div className="stage-actions"><button className="secondary-button" disabled={!available || !library || rewriting || allPlan.blocked || saving} onClick={() => void generate(true)}>{allPlan.confirm ? '重新生成全平台' : allPlan.targets.length < platforms.length ? `补齐未生成平台（${allPlan.targets.length}）` : '改写全部平台'}</button><button className="primary-button" disabled={!available || !library || rewriting || Boolean(draft) || saving} onClick={() => void generate(false)}>{rewriting ? <Loader2 className="spin" size={15} /> : <WandSparkles size={15} />}{rewriting ? '正在改写…' : '一键 AI 改写'}</button></div></header>
      {confirmation && confirmation.taskId === id && <div className="rewrite-confirm inline-notice" role="alertdialog" aria-labelledby="rewrite-confirm-title" aria-describedby="rewrite-confirm-description">
        <strong id="rewrite-confirm-title">重新生成全平台？</strong><p id="rewrite-confirm-description">将覆盖现有所有平台文案，包括已保存的人工微调。生成失败的平台保留原文案，此操作会重新请求模型。</p>
        <div className="stage-actions"><button ref={confirmButton} className="secondary-button" disabled={rewriting} onClick={() => setConfirmation(null)}>保留现有文案</button><button className="primary-button" disabled={rewriting || dirty} onClick={() => void generate(true, true)}>确认覆盖并生成</button></div>
      </div>}
      <div className="platform-tabs" style={{ '--platform-index': platforms.indexOf(platform), '--platform-count': platforms.length } as CSSProperties} role="tablist" aria-label="目标平台">{platforms.map(p => <button key={p} role="tab" tabIndex={platform === p ? 0 : -1} onKeyDown={event => {
        const index = platforms.indexOf(p);
        const next = event.key === 'ArrowRight' ? platforms[(index + 1) % platforms.length]
          : event.key === 'ArrowLeft' ? platforms[(index + platforms.length - 1) % platforms.length]
          : event.key === 'Home' ? platforms[0] : event.key === 'End' ? platforms.at(-1) : undefined;
        if (next) { event.preventDefault(); setPlatform(next); document.getElementById(`tab-${next}`)?.focus(); }
      }} aria-selected={platform === p} aria-controls="copy-panel" id={`tab-${p}`} onClick={() => setPlatform(p)} className={platform === p ? 'selected' : ''}>{platformNames[p]}<span className="platform-save-state">{drafts[`${id}:${p}`] ? '待保存' : phases[`${id}:${p}`] === 'started' && rewriting ? <Loader2 size={11} className="spin" aria-label="正在生成" /> : phases[`${id}:${p}`] === 'failed' ? '失败' : (phases[`${id}:${p}`] === 'saved' || library?.rewritten?.platforms[p]) ? <Check size={11} aria-label="已保存" /> : '未生成'}</span></button>)}</div>
      <div id="copy-panel" role="tabpanel" tabIndex={0} aria-labelledby={`tab-${platform}`} className="copy-panel">
        <p className="copy-hint">{hints[platform]}</p>
        {copy ? <><div className="copy-fields"><label>标题<input aria-label="文案标题" value={copy.title} maxLength={platform === 'bilibili' ? 80 : platform === 'xiaohongshu' ? 40 : 30} disabled={saving || rewriting} onChange={e => update('title', e.target.value)} /></label>{copy.hook !== undefined && <label>开场钩子<input aria-label="开场钩子" value={copy.hook} disabled={saving || rewriting} onChange={e => update('hook', e.target.value)} /></label>}<label>正文<textarea aria-label="文案正文" rows={5} value={copy.body} maxLength={4000} disabled={saving || rewriting} onChange={e => update('body', e.target.value)} /></label><div className="copy-secondary"><label>话题 · 逗号分隔<input aria-label="文案话题" value={copy.tags.join(', ')} disabled={saving || rewriting} onChange={e => update('tags', e.target.value)} /></label>{copy.category !== undefined && <label>推荐分区<input aria-label="推荐分区" value={copy.category} disabled={saving || rewriting} onChange={e => update('category', e.target.value)} /></label>}</div></div>
        <div className="copy-footer"><span>{draft ? '● 有未保存的微调' : `✓ 已保存 · ${saved?.model ?? ''}`}</span><div><button className="text-button" disabled={!draft || saving} onClick={() => setDrafts(old => { const next = { ...old }; delete next[key]; return next; })}><RotateCcw size={13} />还原</button><button className="secondary-button" disabled={!draft || saving || rewriting} onClick={() => void save()}>{saving ? <Loader2 className="spin" size={13} /> : <Save size={13} />}保存微调</button><button className="secondary-button" onClick={() => void copyText()}><Copy size={13} />复制文案</button><button className={`primary-button ${readyToPublish ? 'highlight' : ''}`} style={{ marginLeft: '6px' }} disabled={publishing || rewriting || processing} title={statusHint} onClick={() => void publishCurrentPlatform()}>{publishing ? <Loader2 className="spin" size={13} /> : <Upload size={13} />}发布到{platformNames[platform]}</button></div></div></> : <div className="copy-empty">
          <Sparkles size={27} strokeWidth={1.2} />
          <p>{rewriting ? running[`${id}:rewrite`] : available ? `准备好为 ${platformNames[platform]} 写一份新文案` : '先导入素材，再开始创作表达'}</p>
          <small>{available ? '仅使用原片事实 · 每个平台独立保存 · 支持人工微调 · 直连发布' : '导入视频后，即可为四平台一键生成定制化文案。'}</small>
          <div style={{ marginTop: '14px', display: 'flex', gap: '8px' }}>
            <button className="primary-button" disabled={!available || rewriting || Boolean(draft) || saving} onClick={() => void generate(false)}>
              <WandSparkles size={14} />生成{platformNames[platform]}文案
            </button>
          </div>
        </div>}
        {rewriting && rewriteProgress && <div className="processing-progress"><div role="progressbar" aria-label="平台改写进度" aria-valuemin={0} aria-valuemax={rewriteProgress.total} aria-valuenow={rewriteProgress.completed} aria-valuetext={running[`${id}:rewrite`]}><span style={{ width: `${rewriteProgress.completed / rewriteProgress.total * 100}%` }} /></div><span>{rewriteProgress.completed} / {rewriteProgress.total} 平台已处理</span></div>}
        {rewriting && <div className="operation-status" role="status"><Loader2 size={13} className="spin" /><span>{running[`${id}:rewrite`]} · 已完成的平台立即落盘</span><button className="text-button" onClick={() => void cancel('rewrite')}><Square size={10} />取消</button></div>}
        {dirty && <p className="field-hint">有未保存微调；补齐未生成平台会保留草稿，覆盖前请先保存或还原。</p>}
      </div>
    </div>
    <div className={`processing-card surface ${processed && !processing ? 'processed' : ''}`}>
      <div className="processing-top"><span className="processing-icon">{processed && !processing ? <CheckCircle2 size={23} /> : <Film size={23} />}</span><div><h3>{processed && !processing ? 'PROCESSED_READY · 处理素材已就绪' : '智能防查重处理'}</h3><p>{processed ? `${bytes(processed.video.bytes)} · ${processed.width} × ${processed.height} · ${(processed.durationMs / 1000).toFixed(1)}s 处理耗时` : '微裁剪 · 轻微调色与锐化 · 1.02× 节奏 · 清理源元数据'}</p></div><button className={`process-toggle ${processing || processed ? 'on' : ''}`} role="switch" aria-label="智能防查重处理" aria-checked={Boolean(processing || processed)} disabled={!task?.asset || processing || Boolean(processed)} onClick={() => void process()}><span /></button>{processed && !processing && <button className="text-button" onClick={() => void process()}><RotateCcw size={13} />重新处理</button>}</div>
      {processing ? <div className="processing-progress"><div role="progressbar" aria-label="FFmpeg 处理进度" aria-valuenow={Math.round(percent[id!] ?? 0)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent[id!] ?? 0}%` }} /></div><span>{Math.round(percent[id!] ?? 0)}%</span><button className="text-button" onClick={() => void cancel('process')}>取消处理</button></div> : <p className="processing-note">{task?.asset ? '原视频始终保留；此处理不保证规避平台重复内容识别。请仅处理已获授权的素材。' : '等待视频挂载后可用 · 不依赖 AI 改写完成'}</p>}
    </div>
    {error && <p className="form-error stage-feedback" role="alert">{error}<button className="text-button" onClick={onSettings}>检查设置</button></p>}{notice && <p className="stage-notice" role="status"><Check size={13} />{notice}</p>}
  </section>;
}
