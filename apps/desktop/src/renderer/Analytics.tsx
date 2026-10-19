import { AccountPanel } from './PlatformPanel.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FileCheck2,
  Flame,
  Heart,
  LineChart,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Share2,
  Sparkles,
  Trash2,
  TrendingUp,
  Trophy,
  Video,
  X,
} from 'lucide-react';
import type { AnalyticsSnapshot, PublicationRecord, TargetPlatform } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
import { bytes } from './model.js';
import { platformNames } from './StudioPanel.js';

const platformColors: Record<TargetPlatform, string> = {
  douyin: 'var(--platform-douyin)',
  bilibili: 'var(--platform-bilibili)',
  xiaohongshu: 'var(--platform-xiaohongshu)',
  kuaishou: 'var(--platform-kuaishou)',
};

const platformBadgeStyles: Record<TargetPlatform, { bg: string; text: string; border: string }> = {
  douyin: { bg: 'rgba(30, 30, 34, 0.08)', text: 'var(--text-primary)', border: 'rgba(30, 30, 34, 0.15)' },
  bilibili: { bg: 'rgba(0, 174, 236, 0.12)', text: 'var(--platform-bilibili)', border: 'rgba(0, 174, 236, 0.25)' },
  xiaohongshu: { bg: 'rgba(255, 36, 66, 0.12)', text: 'var(--platform-xiaohongshu)', border: 'rgba(255, 36, 66, 0.25)' },
  kuaishou: { bg: 'rgba(255, 119, 0, 0.12)', text: 'var(--platform-kuaishou)', border: 'rgba(255, 119, 0, 0.25)' },
};

function formatNum(n: number): string {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString();
}

function toLocalDateKey(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr.slice(0, 10);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return dateStr.slice(0, 10);
  }
}

function formatDateDisplay(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr.slice(0, 16).replace('T', ' ');
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}`;
  } catch {
    return dateStr.slice(0, 16).replace('T', ' ');
  }
}

// Generate smooth cubic bezier control points for SVG path
function getCubicBezierPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  const p0 = points[0];
  if (!p0) return '';
  if (points.length === 1) return `M ${p0.x} ${p0.y}`;
  const p1 = points[1];
  if (points.length === 2 && p1) {
    const cp1x = p0.x + (p1.x - p0.x) / 3;
    const cp2x = p1.x - (p1.x - p0.x) / 3;
    return `M ${p0.x} ${p0.y} C ${cp1x} ${p0.y}, ${cp2x} ${p1.y}, ${p1.x} ${p1.y}`;
  }

  let d = `M ${p0.x} ${p0.y}`;
  const tension = 0.2;

  for (let i = 0; i < points.length - 1; i++) {
    const prev = i > 0 ? points[i - 1]! : points[i]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const after = i + 2 < points.length ? points[i + 2]! : next;

    const cp1x = cur.x + (next.x - prev.x) * tension;
    const cp1y = cur.y + (next.y - prev.y) * tension;
    const cp2x = next.x - (after.x - cur.x) * tension;
    const cp2y = next.y - (after.y - cur.y) * tension;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${next.y}`;
  }

  return d;
}

export function Analytics() {
  const [data, setData] = useState<AnalyticsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState('');
  const [showSystemStats, setShowSystemStats] = useState(false);

  // Edit / Calibrate modal state
  const [editingPub, setEditingPub] = useState<PublicationRecord | null>(null);
  const [editForm, setEditForm] = useState<{ views: number; likes: number; comments: number; shares: number; url: string }>({
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    url: '',
  });

  // Sync state
  const [syncing, setSyncing] = useState(false);

  // Filter & Search & Sort states
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortField, setSortField] = useState<'time' | 'views' | 'likes'>('time');

  // Chart configuration states
  const [chartMetric, setChartMetric] = useState<'views' | 'likes'>('views');
  const [chartMode, setChartMode] = useState<'cumulative' | 'daily'>('cumulative');
  const [chartRange, setChartRange] = useState<'7d' | '14d' | '30d' | 'all'>('7d');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const creator = data?.creator;
  const allPublications = useMemo(() => creator?.publications ?? [], [creator?.publications]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snap = unwrap(await api.analytics());
      setData(snap);
      setError('');
      setUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const syncData = async (targetPlatform?: TargetPlatform): Promise<void> => {
    setSyncing(true);
    setError('');
    setNotice('');
    try {
      const res = await api.syncMetrics(targetPlatform);
      if (res && res.ok) {
        const { succeeded, failed, updatedCount } = res.value;
        const messages: string[] = [];
        if (succeeded.length > 0) {
          const names = succeeded.map(p => platformNames[p]).join('、');
          if (updatedCount > 0) {
            messages.push(`已成功从 ${names} 同步最新数据，共更新 ${updatedCount} 篇作品的播放与互动量！`);
          } else {
            messages.push(`已完成 ${names} 创作者数据巡检（线上暂未检测到新增播放或点赞变动）。`);
          }
        }
        if (failed.length > 0) {
          const failDetails = failed.map(f => `${platformNames[f.platform]}: ${f.error}`).join('；');
          setError(`部分平台同步提示：${failDetails}。若平台需要安全验证，您可先在下方「平台账号管理」中点击检查登录，或通过作品右侧铅笔图标手动录入最新数据。`);
        }
        if (messages.length > 0) {
          setNotice(messages.join(' '));
        }
      } else if (res && !res.ok) {
        setError(res.error?.message ?? '同步平台数据失败，请检查网络或重新登录对应平台。');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSyncing(false);
      void refresh();
    }
  };

  async function saveMetrics(): Promise<void> {
    if (!editingPub) return;
    try {
      await api.updatePublication(
        editingPub.id,
        {
          views: Number(editForm.views) || 0,
          likes: Number(editForm.likes) || 0,
          comments: Number(editForm.comments) || 0,
          shares: Number(editForm.shares) || 0,
        },
        editForm.url.trim() || undefined
      );
      setEditingPub(null);
      setNotice('作品数据已校准并同步保存');
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removePublication(id: string): Promise<void> {
    if (!confirm('确定要从数据大盘中移除此作品的监控记录吗？（不会删除实际线上视频）')) return;
    try {
      await api.deletePublication(id);
      setNotice('已从监控大盘移除该作品');
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function openUrl(url?: string): Promise<void> {
    if (!url) return;
    try {
      unwrap(await api.openExternalUrl(url));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const exportToCsv = () => {
    if (!allPublications.length) return;
    const headers = ['作品ID', '发布平台', '作品标题', '发布时间', '播放量', '点赞数', '评论数', '转发数', '作品链接'];
    const rows = filteredPublications.map(p => [
      p.id,
      platformNames[p.platform] || p.platform,
      `"${(p.title || p.taskTitle || '').replace(/"/g, '""')}"`,
      p.publishedAt.slice(0, 19).replace('T', ' '),
      p.metrics?.views ?? 0,
      p.metrics?.likes ?? 0,
      p.metrics?.comments ?? 0,
      p.metrics?.shares ?? 0,
      `"${(p.url || '').replace(/"/g, '""')}"`,
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `OmniPost_监控报表_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setNotice('已成功导出为运营明细表格 (CSV/Excel)');
  };

  // 1. Time Bucket Aggregation for Chart
  const targetPlatforms: TargetPlatform[] = ['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'];

  const chartData = useMemo(() => {
    if (!allPublications.length) return null;

    // Find chronological bounds
    const dates = allPublications
      .map(p => toLocalDateKey(p.publishedAt))
      .sort((a, b) => a.localeCompare(b));
    const minPubDate = dates[0] || toLocalDateKey(new Date().toISOString());
    const maxPubDate = dates[dates.length - 1] || toLocalDateKey(new Date().toISOString());

    // Determine end date
    const endDate = new Date(maxPubDate + 'T00:00:00');
    let dayCount = 7;
    if (chartRange === '14d') dayCount = 14;
    else if (chartRange === '30d') dayCount = 30;
    else if (chartRange === 'all') {
      const start = new Date(minPubDate + 'T00:00:00');
      const diffDays = Math.max(1, Math.round((endDate.getTime() - start.getTime()) / 86400000)) + 1;
      dayCount = Math.max(7, diffDays);
    }

    // Generate strict consecutive date buckets (no duplicates!)
    const buckets: string[] = [];
    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date(endDate.getTime() - i * 86400000);
      buckets.push(toLocalDateKey(d.toISOString()));
    }

    // Compute metrics for each bucket
    type PlatformStats = Record<TargetPlatform, { views: number; likes: number; count: number }>;

    const dailyBucketMap: Record<string, PlatformStats> = {};
    const cumulativeBucketMap: Record<string, PlatformStats> = {};

    for (const b of buckets) {
      dailyBucketMap[b] = {
        douyin: { views: 0, likes: 0, count: 0 },
        bilibili: { views: 0, likes: 0, count: 0 },
        xiaohongshu: { views: 0, likes: 0, count: 0 },
        kuaishou: { views: 0, likes: 0, count: 0 },
      };
      cumulativeBucketMap[b] = {
        douyin: { views: 0, likes: 0, count: 0 },
        bilibili: { views: 0, likes: 0, count: 0 },
        xiaohongshu: { views: 0, likes: 0, count: 0 },
        kuaishou: { views: 0, likes: 0, count: 0 },
      };
    }

    // Populate daily additions
    for (const pub of allPublications) {
      const pubDate = toLocalDateKey(pub.publishedAt);
      const dayStats = dailyBucketMap[pubDate];
      if (dayStats) {
        const platStats = dayStats[pub.platform];
        if (platStats) {
          platStats.views += pub.metrics?.views ?? 0;
          platStats.likes += pub.metrics?.likes ?? 0;
          platStats.count += 1;
        }
      }
    }

    // Populate cumulative totals
    for (const b of buckets) {
      const cumStats = cumulativeBucketMap[b];
      if (cumStats) {
        for (const pub of allPublications) {
          const pubDate = toLocalDateKey(pub.publishedAt);
          if (pubDate <= b) {
            const platStats = cumStats[pub.platform];
            if (platStats) {
              platStats.views += pub.metrics?.views ?? 0;
              platStats.likes += pub.metrics?.likes ?? 0;
              platStats.count += 1;
            }
          }
        }
      }
    }

    const activeMap = chartMode === 'cumulative' ? cumulativeBucketMap : dailyBucketMap;

    // Find max value for Y-scale
    let maxY = 10;
    for (const b of buckets) {
      const stats = activeMap[b];
      if (stats) {
        for (const plat of targetPlatforms) {
          const val = chartMetric === 'views' ? stats[plat].views : stats[plat].likes;
          if (val > maxY) maxY = val;
        }
      }
    }
    maxY = Math.ceil(maxY * 1.15);

    return { buckets, activeMap, maxY };
  }, [allPublications, chartRange, chartMode, chartMetric]);

  // Handle chart coordinates and paths
  const chartLayout = useMemo(() => {
    if (!chartData) return null;
    const { buckets, activeMap, maxY } = chartData;

    const svgWidth = 840;
    const svgHeight = 240;
    const padLeft = 55;
    const padRight = 30;
    const padTop = 25;
    const padBottom = 40;
    const plotW = svgWidth - padLeft - padRight;
    const plotH = svgHeight - padTop - padBottom;

    const xStep = buckets.length > 1 ? plotW / (buckets.length - 1) : plotW / 2;

    const series: Record<TargetPlatform, Array<{ x: number; y: number; val: number; date: string; count: number }>> = {
      douyin: [],
      bilibili: [],
      xiaohongshu: [],
      kuaishou: [],
    };

    buckets.forEach((b, idx) => {
      const x = padLeft + idx * xStep;
      const stats = activeMap[b];
      for (const plat of targetPlatforms) {
        const val = stats ? (chartMetric === 'views' ? stats[plat].views : stats[plat].likes) : 0;
        const count = stats ? stats[plat].count : 0;
        const y = padTop + plotH - (val / maxY) * plotH;
        series[plat].push({ x, y, val, date: b, count });
      }
    });

    const paths: Record<TargetPlatform, { line: string; area: string }> = {
      douyin: { line: '', area: '' },
      bilibili: { line: '', area: '' },
      xiaohongshu: { line: '', area: '' },
      kuaishou: { line: '', area: '' },
    };

    for (const plat of targetPlatforms) {
      const pts = series[plat];
      if (pts.length > 0) {
        const line = getCubicBezierPath(pts);
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (first && last) {
          const area = `${line} L ${last.x} ${padTop + plotH} L ${first.x} ${padTop + plotH} Z`;
          paths[plat] = { line, area };
        }
      }
    }

    return { svgWidth, svgHeight, padLeft, padRight, padTop, padBottom, plotW, plotH, xStep, series, paths };
  }, [chartData, chartMetric]);

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!chartLayout || !chartData) return;
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    // Scale mouse position into viewBox coords
    const viewBoxX = (mouseX / rect.width) * chartLayout.svgWidth;
    const relX = viewBoxX - chartLayout.padLeft;
    const idx = Math.round(relX / chartLayout.xStep);

    if (idx >= 0 && idx < chartData.buckets.length) {
      setHoverIndex(idx);
    } else {
      setHoverIndex(null);
    }
  };

  // Filter & Sort for Publications Detail Table
  const filteredPublications = useMemo(() => {
    return allPublications
      .filter(pub => {
        if (platformFilter !== 'all' && pub.platform !== platformFilter) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          const matchTitle = (pub.title || '').toLowerCase().includes(q);
          const matchTaskTitle = (pub.taskTitle || '').toLowerCase().includes(q);
          if (!matchTitle && !matchTaskTitle) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortField === 'views') return (b.metrics?.views ?? 0) - (a.metrics?.views ?? 0);
        if (sortField === 'likes') return (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0);
        return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
      });
  }, [allPublications, platformFilter, searchQuery, sortField]);

  return (
    <div className="analytics-page">
      {/* 头部标题与操作 */}
      <header className="analytics-heading">
        <div>
          <span className="eyebrow">CREATOR PULSE & OBSERVATORY</span>
          <h1>全网作品成效与监控中心</h1>
          <p>动态追踪多平台发布表现、播放互动与粉丝反馈，让每一次创作皆有声响。</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button className="secondary-button" disabled={!allPublications.length} onClick={exportToCsv} title="导出已发布作品数据报表至 Excel / CSV">
            <Download size={14} />
            <span>导出报表</span>
          </button>
          <button className="secondary-button" disabled={loading || syncing} onClick={() => void syncData()}>
            {syncing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            <span>{syncing ? '正在同步平台数据...' : '同步最新数据'}</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError('')}><X size={15} /></button>
        </div>
      )}
      {notice && (
        <div className="inline-notice" role="status">
          <span>{notice}</span>
          <button className="icon-button" onClick={() => setNotice('')}><X size={14} /></button>
        </div>
      )}

      {!data ? (
        <div className="analytics-loading" role="status">
          <Activity size={23} className="spin" />
          <span>正在读取多平台作品表现与本地记录…</span>
        </div>
      ) : (
        <>
          <div className="analytics-meta">
            <span><i className="dot" />LIVE CREATOR PULSE · 本地安全持久化</span>
            <span>更新于 {updated} · 每 15 秒动态巡检</span>
          </div>

          {/* 1. 核心传播表现 KPI 矩阵 */}
          <section className="kpi-grid" aria-label="全网作品核心指标">
            <article className="kpi-card surface">
              <div>
                <span>全网总播放量</span>
                <Eye size={17} style={{ color: 'var(--chart-blue)' }} />
              </div>
              <strong>{formatNum(creator?.totalViews ?? 0)}</strong>
              <p>四平台已发布作品累计曝光与播放量</p>
            </article>

            <article className="kpi-card surface">
              <div>
                <span>总互动量 & 互动率</span>
                <Flame size={17} style={{ color: 'var(--accent-primary)' }} />
              </div>
              <strong>
                {formatNum((creator?.totalLikes ?? 0) + (creator?.totalComments ?? 0) + (creator?.totalShares ?? 0))}
                <small> · {creator?.averageEngagementRate ?? 0}%</small>
              </strong>
              <p>点赞、评论与转发互动综合比率</p>
            </article>

            <article className="kpi-card surface">
              <div>
                <span>已发布作品数</span>
                <Send size={16} />
              </div>
              <strong>
                {creator?.totalPublished ?? 0}
                <small> 篇作品</small>
              </strong>
              <p>覆盖抖音、哔哩哔哩、小红书与快手</p>
            </article>

            <article className="kpi-card surface">
              <div>
                <span>最佳产出平台</span>
                <Trophy size={16} style={{ color: 'var(--chart-oat)' }} />
              </div>
              <strong>{creator?.topPlatform ? platformNames[creator.topPlatform] : '尚无数据'}</strong>
              <p>{creator?.topPlatform ? '当前贡献最高播放量与互动反馈' : '在工作台发布作品后自动分析'}</p>
            </article>
          </section>

          {/* 2. 多平台播放与传播走势图 (Smooth Bezier Area Chart with Time Buckets) */}
          <section className="surface" style={{ marginTop: '20px', borderRadius: '14px', padding: '20px 22px', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <TrendingUp size={16} style={{ color: 'var(--accent-primary)' }} />
                  <span className="eyebrow" style={{ margin: 0 }}>METRICS TIMELINE</span>
                </div>
                <h2 style={{ fontSize: '15px', fontWeight: 600, margin: '2px 0 0 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  多平台播放与传播走势图
                  <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-muted)' }}>
                    (按日聚合 · 平滑贝塞尔曲线)
                  </span>
                </h2>
              </div>

              {/* 控件栏：平台图例、指标切换、模式切换、时间跨度 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                {/* 平台图例 */}
                <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {targetPlatforms.map(plat => (
                    <span key={plat} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: platformColors[plat], display: 'inline-block' }} />
                      {platformNames[plat]}
                    </span>
                  ))}
                </div>

                {/* 模式切换：累计总量 vs 每日新增 */}
                <div style={{ display: 'flex', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '2px' }}>
                  <button
                    type="button"
                    onClick={() => setChartMode('cumulative')}
                    style={{
                      border: 'none',
                      background: chartMode === 'cumulative' ? 'var(--bg-surface)' : 'transparent',
                      color: chartMode === 'cumulative' ? 'var(--text-primary)' : 'var(--text-muted)',
                      borderRadius: '6px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: chartMode === 'cumulative' ? 600 : 400,
                      cursor: 'pointer',
                      boxShadow: chartMode === 'cumulative' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    累计走势
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartMode('daily')}
                    style={{
                      border: 'none',
                      background: chartMode === 'daily' ? 'var(--bg-surface)' : 'transparent',
                      color: chartMode === 'daily' ? 'var(--text-primary)' : 'var(--text-muted)',
                      borderRadius: '6px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: chartMode === 'daily' ? 600 : 400,
                      cursor: 'pointer',
                      boxShadow: chartMode === 'daily' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    每日新增
                  </button>
                </div>

                {/* 指标切换：播放量 vs 点赞数 */}
                <div style={{ display: 'flex', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '2px' }}>
                  <button
                    type="button"
                    onClick={() => setChartMetric('views')}
                    style={{
                      border: 'none',
                      background: chartMetric === 'views' ? 'var(--bg-surface)' : 'transparent',
                      color: chartMetric === 'views' ? 'var(--text-primary)' : 'var(--text-muted)',
                      borderRadius: '6px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: chartMetric === 'views' ? 600 : 400,
                      cursor: 'pointer',
                      boxShadow: chartMetric === 'views' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    播放量
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartMetric('likes')}
                    style={{
                      border: 'none',
                      background: chartMetric === 'likes' ? 'var(--bg-surface)' : 'transparent',
                      color: chartMetric === 'likes' ? 'var(--text-primary)' : 'var(--text-muted)',
                      borderRadius: '6px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: chartMetric === 'likes' ? 600 : 400,
                      cursor: 'pointer',
                      boxShadow: chartMetric === 'likes' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    获赞数
                  </button>
                </div>

                {/* 时间跨度：7d / 14d / 30d / all */}
                <div style={{ display: 'flex', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '2px' }}>
                  {[
                    { id: '7d', label: '近7天' },
                    { id: '14d', label: '近14天' },
                    { id: '30d', label: '近30天' },
                    { id: 'all', label: '全部' },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setChartRange(tab.id as any)}
                      style={{
                        border: 'none',
                        background: chartRange === tab.id ? 'var(--bg-surface)' : 'transparent',
                        color: chartRange === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                        borderRadius: '6px',
                        padding: '4px 8px',
                        fontSize: '11px',
                        fontWeight: chartRange === tab.id ? 600 : 400,
                        cursor: 'pointer',
                        boxShadow: chartRange === tab.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </header>

            {!chartData || !chartLayout ? (
              <div style={{ height: '200px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '12px', gap: '8px' }}>
                <LineChart size={28} strokeWidth={1.3} style={{ color: 'var(--text-muted)' }} />
                <span>发布作品并同步数据后，将自动在此生成各平台多维走势图表</span>
              </div>
            ) : (
              <div style={{ width: '100%', position: 'relative' }}>
                <div style={{ width: '100%', overflowX: 'auto' }}>
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${chartLayout.svgWidth} ${chartLayout.svgHeight}`}
                    style={{ width: '100%', minWidth: '680px', height: '240px', display: 'block', cursor: 'crosshair' }}
                    onMouseMove={handleSvgMouseMove}
                    onMouseLeave={() => { setHoverIndex(null); }}
                  >
                    <defs>
                      {targetPlatforms.map(plat => (
                        <linearGradient key={plat} id={`grad-bezier-${plat}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={platformColors[plat]} stopOpacity="0.25" />
                          <stop offset="85%" stopColor={platformColors[plat]} stopOpacity="0.03" />
                          <stop offset="100%" stopColor={platformColors[plat]} stopOpacity="0.0" />
                        </linearGradient>
                      ))}
                    </defs>

                    {/* Y 轴水平网格线与数值标尺 */}
                    {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
                      const y = chartLayout.padTop + chartLayout.plotH * (1 - pct);
                      const labelVal = Math.round(chartData.maxY * pct);
                      return (
                        <g key={idx}>
                          <line
                            x1={chartLayout.padLeft}
                            y1={y}
                            x2={chartLayout.svgWidth - chartLayout.padRight}
                            y2={y}
                            stroke="var(--border-subtle)"
                            strokeDasharray={pct === 0 ? 'none' : '3 3'}
                            strokeWidth="1"
                          />
                          <text
                            x={chartLayout.padLeft - 10}
                            y={y + 4}
                            textAnchor="end"
                            fontSize="10"
                            fontFamily="var(--font-data)"
                            fill="var(--text-muted)"
                          >
                            {formatNum(labelVal)}
                          </text>
                        </g>
                      );
                    })}

                    {/* 平台贝塞尔渐变面积与曲线 */}
                    {targetPlatforms.map(plat => {
                      const pathObj = chartLayout.paths[plat];
                      if (!pathObj.line) return null;
                      return (
                        <g key={plat}>
                          {chartLayout.series[plat].length > 1 && (
                            <path d={pathObj.area} fill={`url(#grad-bezier-${plat})`} />
                          )}
                          <path
                            d={pathObj.line}
                            fill="none"
                            stroke={platformColors[plat]}
                            strokeWidth="2.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </g>
                      );
                    })}

                    {/* X 轴日期刻度 */}
                    {chartData.buckets.map((b, idx) => {
                      const x = chartLayout.padLeft + idx * chartLayout.xStep;
                      const y = chartLayout.padTop + chartLayout.plotH + 18;
                      const isHovered = hoverIndex === idx;

                      // For large bucket counts, render alternate labels
                      const skip = chartData.buckets.length > 14 ? 3 : chartData.buckets.length > 7 ? 2 : 1;
                      const shouldRender = idx === 0 || idx === chartData.buckets.length - 1 || idx % skip === 0 || isHovered;

                      if (!shouldRender) return null;

                      const label = b.slice(5); // e.g. "10-18"

                      return (
                        <text
                          key={b}
                          x={x}
                          y={y}
                          textAnchor="middle"
                          fontSize="10"
                          fontFamily="var(--font-data)"
                          fontWeight={isHovered ? 600 : 400}
                          fill={isHovered ? 'var(--text-primary)' : 'var(--text-muted)'}
                        >
                          {label}
                        </text>
                      );
                    })}

                    {/* 鼠标悬停竖线与高亮节点 (Hover Indicator) */}
                    {hoverIndex !== null && hoverIndex >= 0 && hoverIndex < chartData.buckets.length && (
                      <g>
                        {/* 垂直指示虚线 */}
                        <line
                          x1={chartLayout.padLeft + hoverIndex * chartLayout.xStep}
                          y1={chartLayout.padTop}
                          x2={chartLayout.padLeft + hoverIndex * chartLayout.xStep}
                          y2={chartLayout.padTop + chartLayout.plotH}
                          stroke="var(--accent-primary)"
                          strokeWidth="1.2"
                          strokeDasharray="3 3"
                        />

                        {/* 各平台当前日期高亮圆点 */}
                        {targetPlatforms.map(plat => {
                          const pt = chartLayout.series[plat][hoverIndex];
                          if (!pt) return null;
                          return (
                            <g key={plat}>
                              <circle
                                cx={pt.x}
                                cy={pt.y}
                                r="6"
                                fill={platformColors[plat]}
                                opacity="0.2"
                              />
                              <circle
                                cx={pt.x}
                                cy={pt.y}
                                r="4"
                                fill="var(--bg-surface)"
                                stroke={platformColors[plat]}
                                strokeWidth="2.5"
                              />
                            </g>
                          );
                        })}
                      </g>
                    )}
                  </svg>
                </div>

                {/* 悬浮数据卡片 (Glassmorphism Tooltip) */}
                {hoverIndex !== null && hoverIndex >= 0 && hoverIndex < chartData.buckets.length && (
                  (() => {
                    const bDate = chartData.buckets[hoverIndex];
                    if (!bDate) return null;
                    const stats = chartData.activeMap[bDate];
                    if (!stats) return null;

                    const totalMetricVal = targetPlatforms.reduce(
                      (acc, p) => acc + (chartMetric === 'views' ? stats[p].views : stats[p].likes),
                      0
                    );

                    // Compute relative X position in container
                    const relX = chartLayout.padLeft + hoverIndex * chartLayout.xStep;
                    const pctX = (relX / chartLayout.svgWidth) * 100;

                    return (
                      <div
                        style={{
                          position: 'absolute',
                          top: '12px',
                          left: pctX > 75 ? 'auto' : `calc(${pctX}% + 12px)`,
                          right: pctX > 75 ? `calc(${100 - pctX}% + 12px)` : 'auto',
                          background: 'var(--bg-surface)',
                          backdropFilter: 'blur(10px)',
                          border: '1px solid var(--border-default)',
                          boxShadow: 'var(--shadow-dropdown)',
                          borderRadius: '10px',
                          padding: '12px 14px',
                          minWidth: '180px',
                          pointerEvents: 'none',
                          zIndex: 20,
                          fontSize: '11px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '6px', marginBottom: '8px' }}>
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{bDate}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                            {chartMode === 'cumulative' ? '截至当日累计' : '当日发布新增'}
                          </span>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', color: 'var(--accent-primary)', fontWeight: 600 }}>
                          <span>全网总{chartMetric === 'views' ? '播放' : '点赞'}</span>
                          <span>{formatNum(totalMetricVal)}</span>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                          {targetPlatforms.map(plat => {
                            const val = chartMetric === 'views' ? stats[plat].views : stats[plat].likes;
                            return (
                              <div key={plat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: 'var(--text-secondary)' }}>
                                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: platformColors[plat] }} />
                                  {platformNames[plat]}
                                  {stats[plat].count > 0 && (
                                    <small style={{ color: 'var(--text-muted)' }}>({stats[plat].count}篇)</small>
                                  )}
                                </span>
                                <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-data)' }}>
                                  {formatNum(val)}
                                </strong>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            )}
          </section>

          {/* 3. 多平台成效对比 & 互动构成 */}
          <section className="chart-grid" style={{ marginTop: '20px' }}>
            <article className="chart-card surface">
              <header>
                <div>
                  <span className="eyebrow">PLATFORM PERFORMANCE</span>
                  <h2>各平台传播权重对比</h2>
                </div>
                <span className="chart-period">按已发布作品累计</span>
              </header>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '16px' }}>
                {targetPlatforms.map(plat => {
                  const item = creator?.platformBreakdown[plat] ?? { publishedCount: 0, views: 0, likes: 0, comments: 0, shares: 0 };
                  const maxViewsAll = Math.max(1, ...(Object.values(creator?.platformBreakdown ?? {}).map(v => v.views)));
                  const pct = Math.min(100, Math.round((item.views / maxViewsAll) * 100));

                  return (
                    <div key={plat} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: platformColors[plat] }} />
                          {platformNames[plat]}
                          <small style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({item.publishedCount} 篇发布)</small>
                        </span>
                        <span>
                          <strong>{formatNum(item.views)}</strong> 播放 · <small style={{ color: 'var(--text-muted)' }}>{formatNum(item.likes)} 赞</small>
                        </span>
                      </div>
                      <div style={{ height: '7px', background: 'var(--bg-surface-subtle)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${item.publishedCount ? Math.max(4, pct) : 0}%`, height: '100%', background: platformColors[plat], borderRadius: '4px', transition: 'width 0.3s ease' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>

            {/* 全网互动构成 */}
            <article className="chart-card surface">
              <header>
                <div>
                  <span className="eyebrow">ENGAGEMENT BREAKDOWN</span>
                  <h2>全网互动构成</h2>
                </div>
                <span className="chart-period">真实互动占比</span>
              </header>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', height: '160px', marginTop: '10px' }}>
                <div style={{ textAlign: 'center' }}>
                  <Heart size={26} style={{ color: 'var(--accent-primary)', margin: 'auto' }} />
                  <strong style={{ display: 'block', fontSize: '20px', marginTop: '6px' }}>{formatNum(creator?.totalLikes ?? 0)}</strong>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>点赞数</span>
                </div>
                <div style={{ width: '1px', height: '40px', background: 'var(--border-subtle)' }} />
                <div style={{ textAlign: 'center' }}>
                  <MessageSquare size={26} style={{ color: 'var(--platform-bilibili)', margin: 'auto' }} />
                  <strong style={{ display: 'block', fontSize: '20px', marginTop: '6px' }}>{formatNum(creator?.totalComments ?? 0)}</strong>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>评论数</span>
                </div>
                <div style={{ width: '1px', height: '40px', background: 'var(--border-subtle)' }} />
                <div style={{ textAlign: 'center' }}>
                  <Share2 size={26} style={{ color: 'var(--platform-kuaishou)', margin: 'auto' }} />
                  <strong style={{ display: 'block', fontSize: '20px', marginTop: '6px' }}>{formatNum(creator?.totalShares ?? 0)}</strong>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>转发数</span>
                </div>
              </div>
              <p className="chart-footnote">点赞与评论构成了主要的情感共鸣，转发驱动破圈裂变。</p>
            </article>
          </section>

          {/* 4. 补充「作品明细表」模块 (Publications Detail Table Card) */}
          <section className="surface" style={{ marginTop: '26px', borderRadius: '14px', padding: '20px 22px', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px', marginBottom: '16px' }}>
              <div>
                <span className="eyebrow" style={{ margin: 0 }}>PUBLICATIONS OBSERVATORY</span>
                <h2 style={{ fontSize: '15px', fontWeight: 600, margin: '2px 0 0 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  作品成效明细看板
                  <span style={{ fontSize: '11px', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1px 7px', color: 'var(--text-secondary)' }}>
                    {filteredPublications.length} 篇
                  </span>
                </h2>
              </div>

              {/* 工具条：平台筛选、排序切换、关键词搜索 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {/* 平台筛选 */}
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '2px 4px', gap: '2px' }}>
                  {[
                    { id: 'all', label: '全部' },
                    { id: 'douyin', label: '抖音' },
                    { id: 'bilibili', label: 'B站' },
                    { id: 'xiaohongshu', label: '小红书' },
                    { id: 'kuaishou', label: '快手' },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setPlatformFilter(tab.id)}
                      style={{
                        background: platformFilter === tab.id ? 'var(--bg-surface)' : 'transparent',
                        color: platformFilter === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '4px 9px',
                        fontSize: '11px',
                        fontWeight: platformFilter === tab.id ? 600 : 400,
                        cursor: 'pointer',
                        boxShadow: platformFilter === tab.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* 排序方式 */}
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '2px 4px', gap: '2px' }}>
                  {[
                    { id: 'time', label: '最新发布' },
                    { id: 'views', label: '播放最高' },
                    { id: 'likes', label: '点赞最高' },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setSortField(tab.id as any)}
                      style={{
                        background: sortField === tab.id ? 'var(--bg-surface)' : 'transparent',
                        color: sortField === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '4px 9px',
                        fontSize: '11px',
                        fontWeight: sortField === tab.id ? 600 : 400,
                        cursor: 'pointer',
                        boxShadow: sortField === tab.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* 搜索框 */}
                <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                  <Search size={13} style={{ position: 'absolute', left: '9px', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                  <input
                    type="text"
                    placeholder="按标题或素材搜索..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    style={{
                      padding: '5px 10px 5px 28px',
                      fontSize: '11px',
                      borderRadius: '8px',
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-surface-subtle)',
                      color: 'var(--text-primary)',
                      outline: 'none',
                      width: '160px',
                    }}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      style={{ position: 'absolute', right: '6px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px' }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 明细列表卡片 */}
            {!filteredPublications.length ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Send size={32} strokeWidth={1.2} style={{ color: 'var(--text-muted)', margin: '0 auto 10px' }} />
                <p style={{ margin: '0 0 6px', fontSize: '13px', fontWeight: 500 }}>暂无匹配的作品追踪记录</p>
                <small style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                  在「素材工作台」选择平台生成文案并点击「发布到平台」后，作品将被自动录入本数据大盘。
                </small>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-surface-subtle)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '10px' }}>
                      <th style={{ padding: '10px 14px', fontWeight: 500, width: '40%' }}>作品封面与标题</th>
                      <th style={{ padding: '10px 12px', fontWeight: 500 }}>发布平台</th>
                      <th style={{ padding: '10px 12px', fontWeight: 500 }}>发布时间</th>
                      <th style={{ padding: '10px 12px', fontWeight: 500 }}>播放量</th>
                      <th style={{ padding: '10px 12px', fontWeight: 500 }}>获赞</th>
                      <th style={{ padding: '10px 12px', fontWeight: 500 }}>评论/分享</th>
                      <th style={{ padding: '10px 16px', fontWeight: 500, textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPublications.map(pub => {
                      const badge = platformBadgeStyles[pub.platform] ?? platformBadgeStyles.douyin;
                      return (
                        <tr key={pub.id} style={{ borderBottom: '1px solid var(--border-subtle)', transition: 'background 0.15s ease' }}>
                          {/* 封面与标题 */}
                          <td style={{ padding: '12px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {/* 缩略图 */}
                              <div
                                style={{
                                  width: '44px',
                                  height: '44px',
                                  borderRadius: '6px',
                                  background: 'var(--bg-surface-subtle)',
                                  border: '1px solid var(--border-subtle)',
                                  overflow: 'hidden',
                                  flexShrink: 0,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                {pub.cover ? (
                                  <img
                                    src={pub.cover.startsWith('http') || pub.cover.startsWith('data:') ? pub.cover : undefined}
                                    alt="封面"
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                    onError={e => { (e.target as HTMLElement).style.display = 'none'; }}
                                  />
                                ) : (
                                  <Video size={18} style={{ color: 'var(--text-muted)' }} />
                                )}
                              </div>

                              {/* 标题 */}
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px' }} title={pub.title || pub.taskTitle}>
                                  {pub.title || pub.taskTitle || '未命名作品'}
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px' }}>
                                  来源素材: {pub.taskTitle || pub.taskId}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* 平台徽章 */}
                          <td style={{ padding: '12px 12px' }}>
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '2px 8px',
                                borderRadius: '6px',
                                fontSize: '10px',
                                fontWeight: 600,
                                background: badge.bg,
                                color: badge.text,
                                border: `1px solid ${badge.border}`,
                              }}
                            >
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: platformColors[pub.platform] }} />
                              {platformNames[pub.platform] || pub.platform}
                            </span>
                          </td>

                          {/* 发布时间 */}
                          <td style={{ padding: '12px 12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-data)', whiteSpace: 'nowrap' }}>
                            {formatDateDisplay(pub.publishedAt)}
                          </td>

                          {/* 播放量 */}
                          <td style={{ padding: '12px 12px' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-data)' }}>
                              <Eye size={12} style={{ color: 'var(--chart-blue)' }} />
                              {formatNum(pub.metrics?.views ?? 0)}
                            </div>
                          </td>

                          {/* 获赞数 */}
                          <td style={{ padding: '12px 12px' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-data)' }}>
                              <Heart size={12} style={{ color: 'var(--accent-primary)' }} />
                              {formatNum(pub.metrics?.likes ?? 0)}
                            </div>
                          </td>

                          {/* 评论与转发 */}
                          <td style={{ padding: '12px 12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-data)', whiteSpace: 'nowrap' }}>
                            <span>{formatNum(pub.metrics?.comments ?? 0)} 评</span>
                            <span style={{ margin: '0 4px', color: 'var(--border-default)' }}>/</span>
                            <span>{formatNum(pub.metrics?.shares ?? 0)} 转</span>
                          </td>

                          {/* 操作 */}
                          <td style={{ padding: '12px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              {pub.url ? (
                                <button
                                  type="button"
                                  className="secondary-button"
                                  style={{ padding: '3px 8px', fontSize: '11px', height: '26px' }}
                                  onClick={() => void openUrl(pub.url)}
                                  title={`在浏览器中打开: ${pub.url}`}
                                >
                                  <ExternalLink size={12} />
                                  <span>直达</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="text-button"
                                  style={{ padding: '3px 6px', fontSize: '10px', color: 'var(--text-muted)' }}
                                  onClick={() => {
                                    setEditingPub(pub);
                                    setEditForm({
                                      views: pub.metrics?.views ?? 0,
                                      likes: pub.metrics?.likes ?? 0,
                                      comments: pub.metrics?.comments ?? 0,
                                      shares: pub.metrics?.shares ?? 0,
                                      url: pub.url ?? '',
                                    });
                                  }}
                                  title="未录入线上链接，点击录入"
                                >
                                  + 链接
                                </button>
                              )}

                              <button
                                type="button"
                                className="icon-button"
                                style={{ width: '26px', height: '26px' }}
                                onClick={() => {
                                  setEditingPub(pub);
                                  setEditForm({
                                    views: pub.metrics?.views ?? 0,
                                    likes: pub.metrics?.likes ?? 0,
                                    comments: pub.metrics?.comments ?? 0,
                                    shares: pub.metrics?.shares ?? 0,
                                    url: pub.url ?? '',
                                  });
                                }}
                                title="手动校准作品数据"
                              >
                                <Edit3 size={13} />
                              </button>

                              <button
                                type="button"
                                className="icon-button"
                                style={{ width: '26px', height: '26px', color: 'var(--danger-text)' }}
                                onClick={() => void removePublication(pub.id)}
                                title="从大盘移除此作品"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 5. 创作者账号授权与状态面板 */}
          <section style={{ marginTop: '26px' }}>
            <AccountPanel />
          </section>

          {/* 6. 系统底层遥测统计折叠栏 */}
          <section className="surface" style={{ marginTop: '20px', borderRadius: '12px', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
            <header
              onClick={() => setShowSystemStats(!showSystemStats)}
              style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={15} style={{ color: 'var(--text-muted)' }} />
                <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>本地系统吞吐与 Token 遥测数据</h3>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '11px' }}>
                <span>{showSystemStats ? '收起' : '展开详情'}</span>
                {showSystemStats ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </div>
            </header>

            {showSystemStats && (
              <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--border-subtle)' }}>
                <div className="kpi-grid" style={{ marginTop: '14px' }}>
                  <article className="kpi-card surface">
                    <div><span>媒体资产沉淀</span><Database size={15} /></div>
                    <strong>{bytes(data.mediaBytes)}</strong>
                    <p>已落盘归档的视频总大小</p>
                  </article>
                  <article className="kpi-card surface">
                    <div><span>AI 改写与 Token</span><Sparkles size={15} /></div>
                    <strong>{data.tokens.toLocaleString()}<small> tokens</small></strong>
                    <p>{data.aiCalls} 次调用 · {data.aiSuccesses} 次落盘</p>
                  </article>
                  <article className="kpi-card surface">
                    <div><span>FFmpeg 平均耗时</span><Clock3 size={15} /></div>
                    <strong>{data.avgProcessingMs === null ? '—' : (data.avgProcessingMs / 1000).toFixed(1)}<small> 秒</small></strong>
                    <p>轻量处理流水线耗时</p>
                  </article>
                  <article className="kpi-card surface">
                    <div><span>累计任务数</span><FileCheck2 size={15} /></div>
                    <strong>{data.readyTasks}<small> / {data.tasks}</small></strong>
                    <p>视频已就绪 / 全部任务</p>
                  </article>
                </div>

                <div className="analytics-disclosure">
                  <Activity size={14} />
                  <p>
                    统计仅基于本机持久化记录。不估算模型未返回的 Token，不虚构平台流量。
                    {data.incomplete > 0 ? ` 有 ${data.incomplete} 次操作仍在执行或意外中断。` : ''}
                    {data.unreadableRecords > 0 ? ` ${data.unreadableRecords} 条记录无法读取，未计入统计。` : ''}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* 7. 手动校准数据弹窗 (Calibration Dialog) */}
          {editingPub && (
            <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-metric-title">
              <div className="surface" style={{ width: 'min(440px, 90vw)', padding: '24px', borderRadius: '14px', boxShadow: 'var(--shadow-dropdown)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <h3 id="edit-metric-title" style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                    手动校准作品成效（{platformNames[editingPub.platform]}）
                  </h3>
                  <button className="icon-button" onClick={() => setEditingPub(null)}>
                    <X size={16} />
                  </button>
                </div>

                <p style={{ margin: '0 0 16px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  作品：{editingPub.title || editingPub.taskTitle}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    作品回链 URL（支持抖音 / B站 / 小红书 / 快手）
                    <input
                      style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: '12px' }}
                      value={editForm.url}
                      onChange={e => setEditForm(prev => ({ ...prev, url: e.target.value }))}
                      placeholder="https://..."
                    />
                  </label>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      播放量 (Views)
                      <input
                        type="number"
                        min="0"
                        style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: '12px' }}
                        value={editForm.views}
                        onChange={e => setEditForm(prev => ({ ...prev, views: Number(e.target.value) }))}
                      />
                    </label>

                    <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      点赞数 (Likes)
                      <input
                        type="number"
                        min="0"
                        style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: '12px' }}
                        value={editForm.likes}
                        onChange={e => setEditForm(prev => ({ ...prev, likes: Number(e.target.value) }))}
                      />
                    </label>

                    <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      评论数 (Comments)
                      <input
                        type="number"
                        min="0"
                        style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: '12px' }}
                        value={editForm.comments}
                        onChange={e => setEditForm(prev => ({ ...prev, comments: Number(e.target.value) }))}
                      />
                    </label>

                    <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      转发数 (Shares)
                      <input
                        type="number"
                        min="0"
                        style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: '12px' }}
                        value={editForm.shares}
                        onChange={e => setEditForm(prev => ({ ...prev, shares: Number(e.target.value) }))}
                      />
                    </label>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
                  <button className="secondary-button" onClick={() => setEditingPub(null)}>
                    取消
                  </button>
                  <button className="primary-button" onClick={() => void saveMetrics()}>
                    保存校准
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
