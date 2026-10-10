import { AccountPanel } from './PlatformPanel.js';
import { useCallback, useEffect, useState } from 'react';
import { Activity, Clock3, Database, FileCheck2, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { AnalyticsSnapshot, TargetPlatform } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
import { bytes } from './model.js';
import { platformNames } from './StudioPanel.js';
const colors: Record<TargetPlatform, string> = { xiaohongshu: 'var(--accent-primary)', bilibili: 'var(--chart-blue)', douyin: 'var(--chart-oat)', kuaishou: 'var(--chart-sage)' };
export function Analytics() {
  const [data, setData] = useState<AnalyticsSnapshot | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [updated, setUpdated] = useState('');
  const refresh = useCallback(async () => { setLoading(true); try { setData(unwrap(await api.analytics())); setError(''); setUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false })); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
  const max = Math.max(1, ...data?.trend.map(d => d.tasks) ?? [1]);
  const points = data?.trend.map((d, i) => `${36 + i * 66},${154 - d.tasks / max * 115}`).join(' ') ?? '';
  const total = data ? Object.values(data.platforms).reduce((a, b) => a + b, 0) : 0;
  let offset = 0;
  return <div className="analytics-page">
    <header className="analytics-heading"><div><span className="eyebrow">YOUR LOCAL OBSERVATORY</span><h1>每一份内容，都有迹可循。</h1><p>从本地素材到多平台表达，用真实记录看见你的创作节奏。</p></div><button className="secondary-button" disabled={loading} onClick={() => void refresh()}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}刷新</button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data ? <div className="analytics-loading" role="status"><Activity size={23} />正在读取本机任务与操作记录…</div> : <>
      <div className="analytics-meta"><span><i className="dot" />LOCAL DATA ONLY</span><span>更新于 {updated} · 每 15 秒刷新</span></div>
      <section className="kpi-grid" aria-label="核心指标">
        <article className="kpi-card surface"><div><span>累计处理任务</span><FileCheck2 size={16} /></div><strong>{data.readyTasks}<small> / {data.tasks}</small></strong><p>视频已就绪 / 全部任务 · 已转码 {data.processedTasks}</p></article>
        <article className="kpi-card surface"><div><span>媒体吞吐流量</span><Database size={16} /></div><strong>{bytes(data.mediaBytes)}</strong><p>已下载与挂载的视频体积，按任务去重</p></article>
        <article className="kpi-card surface"><div><span>AI 调用与 Token</span><Sparkles size={16} /></div><strong>{data.aiCalls}<small> 次调用</small></strong><p>{data.tokens.toLocaleString()} tokens · {data.callsWithUsage} 次返回用量</p></article>
        <article className="kpi-card surface"><div><span>平均处理耗时</span><Clock3 size={16} /></div><strong>{data.avgProcessingMs === null ? '—' : (data.avgProcessingMs / 1000).toFixed(1)}<small>{data.avgProcessingMs === null ? ' 暂无样本' : ' 秒'}</small></strong><p>成功 FFmpeg 流水线 · 包含校验时间</p></article>
      </section>
      <section className="chart-grid" aria-label="趋势与平台占比">
        <article className="chart-card surface"><header><div><span className="eyebrow">CREATION RHYTHM</span><h2>最近 7 天任务趋势</h2></div><span className="chart-period">UTC · 按创建日期</span></header><svg className="trend-chart" viewBox="0 0 468 196" role="img" aria-label={data.trend.map(d => `${d.date}: ${d.tasks} 个任务`).join('；')}>
          {[0,0.5,1].map(v => <g key={v}><line x1="36" x2="432" y1={154-v*115} y2={154-v*115} stroke="var(--border-subtle)" strokeDasharray="3 5" /><text x="17" y={158-v*115} fill="var(--text-secondary)" fontSize="10" textAnchor="middle">{Number((max*v).toFixed(1))}</text></g>)}
          <polygon points={`36,154 ${points} 432,154`} fill="var(--accent-surface)" /><polyline points={points} fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinejoin="round" />
          {data.trend.map((d, i) => <g key={d.date}><circle cx={36+i*66} cy={154-d.tasks/max*115} r="3.5" fill="var(--accent-primary)" stroke="var(--bg-surface)" strokeWidth="2" /><text x={36+i*66} y="181" textAnchor="middle" fill="var(--text-secondary)" fontSize="10">{d.date.slice(5).replace('-', '/')}</text></g>)}
        </svg><p className="chart-footnote">记录每一次素材任务，包含失败与取消；不代表平台播放量。</p></article>
        <article className="chart-card surface"><header><div><span className="eyebrow">PLATFORM MIX</span><h2>文案改写分布</h2></div><span className="chart-period">累计成功保存</span></header><div className="donut-content"><svg className="donut-chart" viewBox="0 0 180 180" role="img" aria-label={`累计成功改写 ${total} 次`}><circle cx="90" cy="90" r="63" fill="none" stroke="var(--border-subtle)" strokeWidth="17" />{(Object.keys(data.platforms) as TargetPlatform[]).map(p => { const portion = total ? data.platforms[p]/total : 0; const start = offset; offset += portion; return <circle key={p} cx="90" cy="90" r="63" pathLength="100" fill="none" stroke={colors[p]} strokeWidth="17" strokeDasharray={`${portion*100} ${100-portion*100}`} strokeDashoffset={-start*100} transform="rotate(-90 90 90)" />; })}<text x="90" y="89" textAnchor="middle" fill="var(--text-primary)" fontSize="28">{total}</text><text x="90" y="111" textAnchor="middle" fill="var(--text-secondary)" fontSize="10">已保存文案</text></svg><ul className="platform-legend">{(Object.keys(data.platforms) as TargetPlatform[]).map(p => <li key={p}><i style={{ background: colors[p] }} /><span>{platformNames[p]}</span><strong>{data.platforms[p]}</strong><small>{total ? Math.round(data.platforms[p]/total*100) : 0}%</small></li>)}</ul></div><p className="chart-footnote">实际改写次数（含再次生成），不是已发布数量。</p></article>
      </section>
      <AccountPanel />
      <div className="analytics-disclosure"><Activity size={14} /><p>统计仅基于本地持久化记录。不估算模型未返回的 Token，不虚构平台流量。{data.incomplete > 0 ? ` 有 ${data.incomplete} 次操作仍在执行或意外中断。` : ''}{data.unreadableRecords > 0 ? ` ${data.unreadableRecords} 条记录无法读取，未计入统计。` : ''}</p></div>
    </>}
  </div>;
}
