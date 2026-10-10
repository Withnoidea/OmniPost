import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Loader2, Settings2, ShieldCheck, X } from 'lucide-react';
import type { ProxySettings, StudioSettings } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
export function SettingsDialog({ proxy, onClose, onSave }: { proxy: ProxySettings; onClose: () => void; onSave: (proxy: ProxySettings) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [url, setUrl] = useState(proxy.url); const [enabled, setEnabled] = useState(proxy.enabled);
  const [key, setKey] = useState(''); const [changeKey, setChangeKey] = useState(false);
  const [headers, setHeaders] = useState(''); const [changeHeaders, setChangeHeaders] = useState(false);
  const [models, setModels] = useState<string[]>([]); const [testing, setTesting] = useState(false); const [connection, setConnection] = useState('');
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); let live = true;
    void api.studioSettings().then(unwrap).then(value => { if (live) setSettings(value); }).catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; element?.close(); };
  }, []);
  function aiInput() {
    if (!settings) throw new Error('设置尚未读取。');
    let parsed: Record<string, string> | undefined;
    if (changeHeaders) {
      try { parsed = JSON.parse(headers || '{}') as Record<string, string>; }
      catch { throw new Error('自定义 Headers 必须为 JSON 对象，例如 {"X-Workspace": "creator"}。'); }
    }
    return { ...settings.ai, ...(changeKey ? { apiKey: key.trim() } : {}), ...(changeHeaders ? { headers: parsed! } : {}) };
  }
  async function testConnection() {
    if (!settings || testing) return; setTesting(true); setError(''); setConnection(''); setModels([]);
    try {
      const result = unwrap(await api.fetchModels({ ...aiInput(), model: settings.ai.model || 'custom' }));
      setModels(result); setConnection(`连接成功，获取到 ${result.length} 个模型。模型列表不代表具体模型一定支持改写。`);
    } catch (e) { setError(`${errorMessage(e)} 若服务不支持模型列表，可手动填写模型后保存。`); }
    finally { setTesting(false); }
  }
  async function save(): Promise<void> {
    if (!settings) return; setSaving(true); setError('');
    try {
      // Independently atomic settings groups: surface failures without claiming an all-or-nothing save.
      const saved = unwrap(await api.saveStudioSettings({ ai: aiInput(), processor: settings.processor }));
      setSettings(saved); setKey(''); setChangeKey(false); setHeaders(''); setChangeHeaders(false);
      const nextProxy = unwrap(await api.setProxy({ enabled, url })); onSave(nextProxy);
      if (!saved.ai.persisted || !nextProxy.persisted) setError('系统加密不可用：凭据仅保留于本次会话。其他设置已保存。'); else onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }
  return <dialog className="settings-dialog unified-settings" ref={dialog} onCancel={e => { if (saving || testing) e.preventDefault(); else onClose(); }} aria-labelledby="settings-title">
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="dialog-heading"><span className="icon-tile"><Settings2 size={20} /></span><button type="button" className="icon-button" disabled={saving || testing} aria-label="关闭设置" onClick={onClose}><X size={18} /></button></div>
      <h2 id="settings-title">让工具，适应你的习惯。</h2><p>全局设置 · 本地保存 · 新任务生效</p>
      {!settings ? <p role="status"><Loader2 className="spin" size={16} />读取设置…</p> : <>
      <fieldset disabled={saving || testing} className="settings-section"><legend><KeyRound size={14} />AI 模型连接</legend>
        <div className="protocol-switch" role="group" aria-label="AI 连接协议">{([['openai', 'OpenAI 兼容协议'], ['anthropic', 'Anthropic 原生协议']] as const).map(([protocol, label]) => <button type="button" key={protocol} aria-pressed={settings.ai.protocol === protocol} onClick={() => { setSettings({ ...settings, ai: { ...settings.ai, protocol, temperature: Math.min(settings.ai.temperature, protocol === 'anthropic' ? 1 : 2) } }); setModels([]); setConnection(''); }}>{label}</button>)}</div>
        <div className="provider-presets">{[['DeepSeek','https://api.deepseek.com/v1','deepseek-chat'],['OpenAI','https://api.openai.com/v1','gpt-4o-mini'],['Ollama','http://127.0.0.1:11434/v1','qwen3:8b'],['Claude','https://api.anthropic.com/v1','claude-sonnet-4-6']].map(([name, baseURL, model]) => <button type="button" className="chip-button" key={name} onClick={() => { setSettings({ ...settings, ai: { ...settings.ai, baseURL: baseURL!, model: model!, protocol: name === 'Claude' ? 'anthropic' : 'openai', temperature: 0.7 } }); setChangeKey(true); setKey(''); setHeaders('{}'); setChangeHeaders(true); setModels([]); setConnection(''); }}>{name}</button>)}</div>
        <label className="field-label" htmlFor="ai-url">Base URL</label><input id="ai-url" required value={settings.ai.baseURL} onChange={e => { setSettings({ ...settings, ai: { ...settings.ai, baseURL: e.target.value } }); setModels([]); setConnection(''); }} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
        <label className="field-label" htmlFor="ai-key">API Key <span>{settings.ai.hasApiKey ? '已配置 · 留空保持不变' : '本地 Ollama 可留空'}</span></label><input id="ai-key" type="password" autoComplete="new-password" value={key} placeholder={settings.ai.hasApiKey ? '••••••••（已安全保存）' : '仅发送至所配置的 API 服务'} onChange={e => { setKey(e.target.value); setChangeKey(true); }} />
        {settings.ai.hasApiKey && <button className="text-button" type="button" onClick={() => { setKey(''); setChangeKey(true); }}>清除已保存密钥{changeKey && !key ? '（保存后生效）' : ''}</button>}
        <div className="model-connect"><button type="button" className="secondary-button" onClick={() => void testConnection()}>{testing ? <Loader2 size={15} className="spin" /> : <Check size={15} />}{testing ? '正在测试连接…' : '测试连接并获取模型'}</button></div>
        {connection && <p className="inline-notice" role="status">{connection}</p>}
        {models.length > 0 && <label className="field-label">可用模型<select aria-label="可用模型" value={models.includes(settings.ai.model) ? settings.ai.model : ''} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, model: e.target.value } })}><option value="" disabled>选择一个模型，或下方手动输入</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
        <div className="settings-grid"><label className="field-label">模型（可自定义）<input id="ai-model" required value={settings.ai.model} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, model: e.target.value } })} /></label><label className="field-label">Temperature<input id="ai-temperature" type="number" min="0" max={settings.ai.protocol === 'anthropic' ? 1 : 2} step="0.1" required value={settings.ai.temperature} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, temperature: e.target.valueAsNumber } })} /></label></div>
        <label className="check-line"><input type="checkbox" disabled={settings.ai.protocol === 'anthropic'} checked={settings.ai.jsonMode} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, jsonMode: e.target.checked } })} />请求 JSON 模式 <small>{settings.ai.protocol === 'anthropic' ? 'Anthropic 使用原生 Messages 协议，无需此选项' : '不支持 response_format 时可关闭'}</small></label>
        <details className="advanced-settings"><summary>高级配置 · Headers / System Prompt</summary>
          <label className="field-label" htmlFor="ai-headers">自定义请求 Headers <span>{settings.ai.hasCustomHeaders ? '已安全保存 · 留空不修改' : 'JSON 对象；密钥请使用上方 API Key'}</span></label><textarea id="ai-headers" rows={3} value={headers} spellCheck={false} onChange={e => { setHeaders(e.target.value); setChangeHeaders(true); }} placeholder={'{"X-Workspace": "creator"}'} />
          <p className="field-hint">输入 {`{}`} 可清除。禁止覆盖 Host、Authorization、Cookie 等路由和认证头；自定义 Headers 也会加密保存。</p>
          <label className="field-label" htmlFor="ai-system">System Prompt 微调</label><textarea id="ai-system" rows={3} maxLength={16000} value={settings.ai.systemPrompt} onChange={e => setSettings({ ...settings, ai: { ...settings.ai, systemPrompt: e.target.value } })} placeholder="例如：语气自然克制，不要使用夸张营销表达。" /><p className="field-hint">作为编辑偏好追加，保留四平台输出结构约束。</p>
        </details>
        <p className="field-hint">改写将原标题、简介与内嵌字幕文本发送至上方服务。不上传视频，也不读取 Cookie。更换服务时请更换密钥。</p>
      </fieldset>
      <fieldset disabled={saving || testing} className="settings-section"><legend>下载网络代理</legend><label className="switch-line">使用代理连接<input type="checkbox" role="switch" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span className={enabled ? 'switch on' : 'switch'} aria-hidden="true" /></label><label className="field-label" htmlFor="proxy-url">代理地址</label><input id="proxy-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:7890" spellCheck={false} /><p className="field-hint">支持 HTTP / HTTPS / SOCKS5；仅用于 Fetcher，不代理 LLM 或系统流量。</p></fieldset>
      <fieldset disabled={saving || testing} className="settings-section"><legend>FFmpeg 轻量处理</legend><div className="settings-grid">{([['speed','变速倍率',0.5,2,0.01],['cropPercent','总裁剪比例 %',0,10,0.1],['contrast','对比度',0.8,1.2,0.01],['sharpen','锐化强度',0,1,0.05]] as const).map(([name,label,min,max,step]) => <label key={name} className="field-label">{label}<input id={`ffmpeg-${name}`} type="number" min={min} max={max} step={step} required value={settings.processor[name]} onChange={e => setSettings({ ...settings, processor: { ...settings.processor, [name]: e.target.valueAsNumber } })} /></label>)}</div><p className="field-hint">输出 H.264 / AAC，保留原片。微调不保证绕过平台重复内容识别，请仅处理有权使用的内容。</p></fieldset>
      </>}
      <div className="privacy-note"><ShieldCheck size={16} /><span>API Key 与代理凭据使用 Windows 系统加密；不可用时不明文落盘。</span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={saving || testing} onClick={onClose}>取消</button><button className="primary-button" disabled={!settings || saving || testing}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}保存设置</button></div>
    </form>
  </dialog>;
}
