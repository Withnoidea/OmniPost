import { AccountPanel } from './PlatformPanel.js';
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Edit3,
  ExternalLink,
  Eye,
  FileCheck2,
  Flame,
  Heart,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Share2,
  Sparkles,
  Trash2,
  Trophy,
  X,
} from 'lucide-react';
import type { AnalyticsSnapshot, PublicationRecord, TargetPlatform } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
import { bytes } from './model.js';
import { platformNames } from './StudioPanel.js';

const colors: Record<TargetPlatform, string> = {
  xiaohongshu: 'var(--accent-primary)',
  bilibili: 'var(--chart-blue)',
  douyin: 'var(--chart-oat)',
  kuaishou: 'var(--chart-sage)',
};

function formatNum(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  return n.toLocaleString();
}

export function Analytics() {
  const [data, setData] = useState<AnalyticsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState('');
  const [showSystemStats, setShowSystemStats] = useState(false);
  const [editingPub, setEditingPub] = useState<PublicationRecord | null>(null);
  const [editForm, setEditForm] = useState<{ views: number; likes: number; comments: number; shares: number; url: string }>({
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    url: '',
  });

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
      setNotice('作品数据已更新');
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removePublication(id: string): Promise<void> {
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

  const creator = data?.creator;

  return (
    <div className="analytics-page">
      <header className="analytics-heading">
        <div>
          <span className="eyebrow">CREATOR PULSE & OBSERVATORY</span>
          <h1>全网作品成效与监控中心</h1>
          <p>动态追踪多平台发布表现、播放互动与粉丝反馈，让每一次创作皆有声响。</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button className="secondary-button" disabled={loading} onClick={() => void refresh()}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            <span>同步最新数据</span>
          </button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')}><X size={15} /></button></div>}
      {notice && <div className="inline-notice" role="status"><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')}><X size={14} /></button></div>}

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
                <Eye size={17} />
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

          {/* 2. 多平台成效对比卡片 */}
          <section className="chart-grid" style={{ marginTop: '20px' }}>
            <article className="chart-card surface">
              <header>
                <div>
                  <span className="eyebrow">PLATFORM PERFORMANCE</span>
                  <h2>各平台传播表现对比</h2>
                </div>
                <span className="chart-period">按已发布作品数据</span>
              </header>

              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {(['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'] as TargetPlatform[]).map(plat => {
                  const item = creator?.platformBreakdown[plat] ?? { publishedCount: 0, views: 0, likes: 0, comments: 0, shares: 0 };
                  const maxViewsAll = Math.max(1, ...(Object.values(creator?.platformBreakdown ?? {}).map(v => v.views)));
                  const pct = Math.min(100, Math.round((item.views / maxViewsAll) * 100));

                  return (
                    <div key={plat} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: colors[plat] }} />
                          {platformNames[plat]}
                          <small style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({item.publishedCount} 篇发布)</small>
                        </span>
                        <span>
                          <strong>{formatNum(item.views)}</strong> 播放 · <small style={{ color: 'var(--text-muted)' }}>{formatNum(item.likes)} 赞</small>
                        </span>
                      </div>
                      <div style={{ height: '7px', background: 'var(--bg-surface-subtle)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${item.publishedCount ? Math.max(4, pct) : 0}%`, height: '100%', background: colors[plat], borderRadius: '4px', transition: 'width 0.3s ease' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>

            {/* 3. 互动结构分布 */}
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
                  <MessageSquare size={26} style={{ color: 'var(--chart-blue)', margin: 'auto' }} />
                  <strong style={{ display: 'block', fontSize: '20px', marginTop: '6px' }}>{formatNum(creator?.totalComments ?? 0)}</strong>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>评论数</span>
                </div>
                <div style={{ width: '1px', height: '40px', background: 'var(--border-subtle)' }} />
                <div style={{ textAlign: 'center' }}>
                  <Share2 size={26} style={{ color: 'var(--chart-sage)', margin: 'auto' }} />
                  <strong style={{ display: 'block', fontSize: '20px', marginTop: '6px' }}>{formatNum(creator?.totalShares ?? 0)}</strong>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>转发数</span>
                </div>
              </div>
              <p className="chart-footnote">点赞与评论构成了主要的情感共鸣，转发驱动破圈裂变。</p>
            </article>
          </section>

          {/* 4. 已发布作品详细看板 */}
          <section style={{ marginTop: '26px' }}>
            <div className="section-heading">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '14px', fontWeight: 600, margin: 0 }}>
                  已发布作品成效追踪 <span>{String(creator?.publications.length ?? 0).padStart(2, '0')}</span>
                </h2>
              </div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>本地持久化绑定 · 支持录入或点击跳转平台作品</span>
            </div>

            <div className="surface" style={{ overflow: 'hidden', borderRadius: '12px', marginTop: '10px' }}>
              {!creator?.publications.length ? (
                <div style={{ padding: '36px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  <Send size={32} strokeWidth={1.2} style={{ color: 'var(--text-muted)', margin: '0 auto 10px' }} />
                  <p style={{ margin: '0 0 6px', fontSize: '12px', fontWeight: 500 }}>暂无已发布作品追踪记录</p>
                  <small style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                    在「素材工作台」选择平台生成文案并点击「发布到平台」后，作品将被自动录入本数据大盘。
                  </small>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-surface-subtle)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '10px' }}>
                        <th style={{ padding: '10px 16px', fontWeight: 500 }}>作品标题与素材</th>
                        <th style={{ padding: '10px 14px', fontWeight: 500 }}>平台</th>
                        <th style={{ padding: '10px 14px', fontWeight: 500 }}>发布时间</th>
                        <th style={{ padding: '10px 14px', fontWeight: 500 }}>播放量</th>
                        <th style={{ padding: '10px 14px', fontWeight: 500 }}>点赞</th>
                        <th style={{ padding: '10px 14px', fontWeight: 500 }}>评论</th>
                        <th style={{ padding: '10px 14px', fontWeight: 500 }}>分享</th>
                        <th style={{ padding: '10px 16px', fontWeight: 500, textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {creator.publications.map(pub => (
                        <tr key={pub.id} style={{ borderBottom: '1px solid var(--border-subtle)', transition: 'background 0.15s ease' }}>
                          <td style={{ padding: '12px 16px', maxWidth: '280px' }}>
                            <strong style={{ display: 'block', fontSize: '12px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {pub.title || pub.taskTitle}
                            </strong>
                            <small style={{ color: 'var(--text-muted)', fontSize: '9px' }}>原素材: {pub.taskTitle}</small>
                          </td>
                          <td style={{ padding: '12px 14px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 7px', borderRadius: '5px', fontSize: '10px', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)' }}>
                              <i style={{ width: '5px', height: '5px', borderRadius: '50%', background: colors[pub.platform] }} />
                              {platformNames[pub.platform]}
                            </span>
                          </td>
                          <td style={{ padding: '12px 14px', color: 'var(--text-secondary)', fontSize: '10px', whiteSpace: 'nowrap' }}>
                            {pub.publishedAt.slice(0, 16).replace('T', ' ')}
                          </td>
                          <td style={{ padding: '12px 14px', fontWeight: 600 }}>{formatNum(pub.metrics?.views ?? 0)}</td>
                          <td style={{ padding: '12px 14px', color: 'var(--text-secondary)' }}>{formatNum(pub.metrics?.likes ?? 0)}</td>
                          <td style={{ padding: '12px 14px', color: 'var(--text-secondary)' }}>{formatNum(pub.metrics?.comments ?? 0)}</td>
                          <td style={{ padding: '12px 14px', color: 'var(--text-secondary)' }}>{formatNum(pub.metrics?.shares ?? 0)}</td>
                          <td style={{ padding: '12px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                              {pub.url && (
                                <button className="icon-button" title="在平台打开作品" onClick={() => void openUrl(pub.url)}>
                                  <ExternalLink size={13} />
                                </button>
                              )}
                              <button
                                className="icon-button"
                                title="录入/编辑作品数据与链接"
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
                              >
                                <Edit3 size={13} />
                              </button>
                              <button className="icon-button queue-delete-btn" title="删除该条记录" onClick={() => void removePublication(pub.id)}>
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* 5. 平台账号授权管理 */}
          <AccountPanel />

          {/* 6. 可折叠底栏：本地工程与能耗明细 */}
          <section style={{ marginTop: '28px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
            <button
              className="text-button"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}
              onClick={() => setShowSystemStats(!showSystemStats)}
            >
              <Database size={13} />
              <span>本地工程开销与 Token 消耗明细</span>
              {showSystemStats ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {showSystemStats && (
              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div className="kpi-grid">
                  <article className="kpi-card surface">
                    <div><span>素材媒体吞吐</span><Database size={15} /></div>
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

          {/* 7. 编辑/录入作品数据弹窗 */}
          {editingPub && (
            <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-metric-title">
              <div className="surface" style={{ width: 'min(440px, 90vw)', padding: '24px', borderRadius: '14px', boxShadow: 'var(--shadow-dropdown)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <h3 id="edit-metric-title" style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                    录入 / 更新作品表现（{platformNames[editingPub.platform]}）
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
                    保存更新
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
