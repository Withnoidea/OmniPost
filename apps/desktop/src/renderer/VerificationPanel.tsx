import { useState } from 'react';
import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import type { DownloadTask } from '../shared/contracts.js';
import { api, unwrap, errorMessage } from './bridge.js';
export function VerificationPanel({ task, onTask }: { task: DownloadTask; onTask: (task: DownloadTask) => void }) {
  const [opened, setOpened] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function verify(finish: boolean) {
    setBusy(true); setError('');
    try {
      if (finish) { const next = unwrap(await api.finishVerification(task.id)); setOpened(false); onTask(next); }
      else { unwrap(await api.openVerification(task.id)); setOpened(true); }
    } catch (e) { setError(errorMessage(e)); setOpened(false); } finally { setBusy(false); }
  }
  return <div className="verification-panel"><div><ShieldCheck size={20} /><strong>需要人工验证</strong></div><p>在隔离窗口中完成滑块验证或登录，再返回这里保存 Cookie 并重试。不自动破解验证。</p>
    <div className="publish-controls"><button className="secondary-button" disabled={busy} onClick={() => void verify(false)}>{busy ? <Loader2 size={15} className="spin" /> : <ExternalLink size={15} />}打开验证窗口</button>{opened && <button className="primary-button" disabled={busy} onClick={() => void verify(true)}>验证完成，保存并重试</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
