import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Loader2, Settings2, ShieldCheck, X } from 'lucide-react';
import type { ProxySettings, StudioSettings } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
export function SettingsDialog({ proxy, onClose, onSave }: { proxy: ProxySettings; onClose: () => void; onSave: (proxy: ProxySettings) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [url, setUrl] = useState(proxy.url); const [enabled, setEnabled] = useState(proxy.enabled);
  const [key, setKey] = useState(''); const [changeKey, setChangeKey] = useState(false);
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); let live = true;
    void api.studioSettings().then(unwrap).then(value => { if (live) setSettings(value); }).catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; element?.close(); };
  }, []);
  async function save(): Promise<void> {
    if (!settings) return; setSaving(true); setError('');
    try {
      // Independently atomic settings groups: surface failures without claiming an all-or-nothing save.
      const saved = unwrap(await api.saveStudioSettings({ ai: { ...settings.ai, ...(changeKey ? { apiKey: key.trim() } : {}) }, processor: settings.processor }));
      setSettings(saved); setKey(''); setChangeKey(false);
      const nextProxy = unwrap(await api.setProxy({ enabled, url })); onSave(nextProxy);
      if (!saved.ai.persisted || !nextProxy.persisted) setError('系统加密不可用：凭据仅保留于本次会话。其他设置已保存。'); else onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }
  return <dialog className="settings-dialog unified-settings" ref={dialog} onCancel={e => { if (saving) e.preventDefault(); else onClose(); }} aria-labelledby="settings-title">
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="dialog-heading"><span className="icon-tile"><Settings2 size={20} /></span><button type="button" className="icon-button" disabled={saving} aria-label="关闭设置" onClick={onClose}><X size={18} /></button></div>
      <h2 id="settings-title">让工具，适应你的习惯。</h2><p>全局设置 · 本地保存 · 新任务生效</p>
      {!settings ? <p role="status"><Loader2 className="spin" size={16} />读取设置…</p> : <>
      <fieldset disabled={saving} className="settings-section"><legend><KeyRound size={14} />AI 模型连接</legend>
        <div className="provider-presets">{[['DeepSeek','https://api.deepseek.com/v1','deepseek-chat'],['OpenAI','https://api.openai.com/v1','gpt-4o-mini'],['Ollama','http://127.0.0.1:11434/v1','qwen3:8b']].map(([name, baseURL, model]) => <button type="button" className="chip-button" key={name} onClick={() => { setSettings({ ...settings, ai: { ...settings.ai, baseURL: baseURL!, model: model! } }); setChangeKey(true); setKey(''); }}>{name}</button>)}</div>
        <label className="field-label" htmlFor="ai-url">Base URL</label><input id="ai-url" required value={settings.ai.baseURL} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, baseURL: e.target.value } })} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
        <label className="field-label" htmlFor="ai-key">API Key <span>{settings.ai.hasApiKey ? '已配置 · 留空保持不变' : '本地 Ollama 可留空'}</span></label><input id="ai-key" type="password" autoComplete="new-password" value={key} placeholder={settings.ai.hasApiKey ? '••••••••（已安全保存）' : '仅发送至所配置的 API 服务'} onChange={e => { setKey(e.target.value); setChangeKey(true); }} />
        {settings.ai.hasApiKey && <button className="text-button" type="button" onClick={() => { setKey(''); setChangeKey(true); }}>清除已保存密钥{changeKey && !key ? '（保存后生效）' : ''}</button>}
        <div className="settings-grid"><label className="field-label">模型<input id="ai-model" required value={settings.ai.model} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, model: e.target.value } })} /></label><label className="field-label">Temperature<input id="ai-temperature" type="number" min="0" max="2" step="0.1" required value={settings.ai.temperature} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, temperature: e.target.valueAsNumber } })} /></label></div>
        <label className="check-line"><input type="checkbox" checked={settings.ai.jsonMode} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, jsonMode: e.target.checked } })} />请求 JSON 模式 <small>不支持 response_format 时可关闭</small></label>
        <p className="field-hint">改写将原标题、简介与内嵌字幕文本发送至上方服务。不上传视频，也不读取 Cookie。更换服务时请更换密钥。</p>
      </fieldset>
      <fieldset disabled={saving} className="settings-section"><legend>下载网络代理</legend><label className="switch-line">使用代理连接<input type="checkbox" role="switch" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span className={enabled ? 'switch on' : 'switch'} aria-hidden="true" /></label><label className="field-label" htmlFor="proxy-url">代理地址</label><input id="proxy-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:7890" spellCheck={false} /><p className="field-hint">支持 HTTP / HTTPS / SOCKS5；仅用于 Fetcher，不代理 LLM 或系统流量。</p></fieldset>
      <fieldset disabled={saving} className="settings-section"><legend>FFmpeg 轻量处理</legend><div className="settings-grid">{([['speed','变速倍率',0.5,2,0.01],['cropPercent','总裁剪比例 %',0,10,0.1],['contrast','对比度',0.8,1.2,0.01],['sharpen','锐化强度',0,1,0.05]] as const).map(([name,label,min,max,step]) => <label key={name} className="field-label">{label}<input id={`ffmpeg-${name}`} type="number" min={min} max={max} step={step} required value={settings.processor[name]} onChange={e => setSettings({ ...settings, processor: { ...settings.processor, [name]: e.target.valueAsNumber } })} /></label>)}</div><p className="field-hint">输出 H.264 / AAC，保留原片。微调不保证绕过平台重复内容识别，请仅处理有权使用的内容。</p></fieldset>
      </>}
      <div className="privacy-note"><ShieldCheck size={16} /><span>API Key 与代理凭据使用 Windows 系统加密；不可用时不明文落盘。</span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" disabled={!settings || saving}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}保存设置</button></div>
    </form>
  </dialog>;
}
