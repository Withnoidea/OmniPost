import { useEffect, useRef, useState } from 'react';
import { FilePenLine, FileVideo2, ImagePlus, Loader2, X } from 'lucide-react';
import type { DownloadTask, MediaSelection } from '../shared/contracts.js';
import { metadataOf } from './model.js';
import { api, unwrap, errorMessage } from './bridge.js';

export function ManualDialog({ task, onClose, onSaved }: { task?: DownloadTask; onClose: () => void; onSaved: (task: DownloadTask) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const metadata = metadataOf(task);
  const [title, setTitle] = useState(metadata?.title ?? '');
  const [description, setDescription] = useState(metadata?.description ?? '');
  const [tags, setTags] = useState(metadata?.tags.join(', ') ?? '');
  const [author, setAuthor] = useState(metadata?.uploader ?? metadata?.channel ?? '');
  const [video, setVideo] = useState<MediaSelection | null>(null);
  const [cover, setCover] = useState<MediaSelection | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  async function choose(kind: 'video' | 'cover') {
    try { const file = unwrap(await api.chooseMedia(kind)); if (file) (kind === 'video' ? setVideo : setCover)(file); }
    catch (e) { setError(errorMessage(e)); }
  }
  function drop(files: FileList) {
    if (busy) return;
    for (const file of Array.from(files)) {
      try {
        const selected = api.droppedMedia(file);
        if (!selected.path) throw new Error('请拖入本机文件，不支持网页链接。');
        if (/\.mp4$/i.test(file.name)) setVideo(selected);
        else if (/\.(jpe?g|png)$/i.test(file.name)) setCover(selected);
        else throw new Error('支持 MP4 视频和 JPG / PNG 封面。');
      } catch (e) { setError(errorMessage(e)); }
    }
  }
  async function save() {
    if (busy) return; setBusy(true); setError('');
    try {
      const saved = unwrap(await api.createManual({ title, description, author, tags: tags.split(/[,，\n]/).map(tag => tag.trim().replace(/^#/, '')).filter(Boolean),
        ...(task ? { sourceTaskId: task.id } : {}), ...(video ? { videoPath: video.path } : {}), ...(cover ? { coverPath: cover.path } : {}) }));
      onSaved(saved);
      if (saved.error) setError(`${saved.error.message} [${saved.error.code}]`); else onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="settings-dialog manual-dialog" aria-labelledby="manual-title" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="dialog-heading"><span className="icon-tile"><FilePenLine size={20} /></span><button type="button" className="icon-button" aria-label="关闭手动录入" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <h2 id="manual-title">{task ? '手动补全，继续创作。' : '不需要链接，也能开始。'}</h2>
      <p>{task ? '另存为新素材，保留原任务、文案与成品。' : '本地视频 + 你的文字，直接接入创作流水线。'}</p>
      <fieldset disabled={busy} className="settings-section">
        <label className="field-label" htmlFor="manual-title-input">标题</label><input id="manual-title-input" required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} placeholder="给这份内容一个标题" />
        <label className="field-label" htmlFor="manual-description">简介</label><textarea id="manual-description" rows={4} maxLength={50000} value={description} onChange={e => setDescription(e.target.value)} placeholder="讲了什么、有哪些重点，或补充一段字幕…" />
        <div className="settings-grid"><label className="field-label">标签 Tags<input value={tags} maxLength={10000} onChange={e => setTags(e.target.value)} placeholder="创作, 灵感, 日常（逗号分隔）" /></label><label className="field-label">作者信息<input value={author} maxLength={500} onChange={e => setAuthor(e.target.value)} placeholder="作者 / 频道名称" /></label></div>
        <div className="manual-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); drop(e.dataTransfer.files); }}>
          <div><FileVideo2 size={24} /><strong>拖入本地视频与封面</strong><small>MP4 · JPG / PNG · 原始文件不会被修改</small></div>
          <button type="button" className="secondary-button" onClick={() => void choose('video')}><FileVideo2 size={15} />{video?.name ?? (task?.asset ? '沿用已挂载视频 · 可替换' : '选择 MP4 视频')}</button>
          <button type="button" className="secondary-button" onClick={() => void choose('cover')}><ImagePlus size={15} />{cover?.name ?? (metadata ? '沿用可用封面 · 可替换' : '选择封面（可选）')}</button>
        </div>
        <p className="field-hint">{video || task?.asset ? '保存时校验 MP4，成功后进入 READY，可改写、加工及发布预填。' : '也可先保存文字，稍后挂载视频。未提供封面时使用占位图。'}</p>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? <Loader2 size={16} className="spin" /> : <FilePenLine size={16} />}{busy ? '复制并校验素材…' : '保存并继续'}</button></div>
    </form>
  </dialog>;
}
