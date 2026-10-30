import type { KnowledgeVersion } from '@agentos/shared';
import { useState, type FormEvent } from 'react';
import { api, useApi } from '../../api.ts';
import { cx, Empty, Spinner } from '../../ui.tsx';

const FIELD = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800';
const BUTTON = 'rounded-lg bg-brand-600 px-3 py-2 text-sm text-white disabled:opacity-50';
interface Metrics { total: number; answered: number; clarify: number; handoff: number; faqReuse: number; averageLatencyMs: number | null; activeDocuments: number; }
interface FaqSource { id: string; question: string; answer: string; }

function versionStatus(version: KnowledgeVersion, versions: KnowledgeVersion[]): string {
  const today = new Date().toISOString().slice(0, 10);
  if (version.archived) return '已停用';
  if (version.status === 'draft') return '待审核草稿';
  if (version.effectiveFrom && version.effectiveFrom > today) return '待生效';
  const latest = versions.find((v) => v.documentId === version.documentId && v.status === 'published' && (!v.effectiveFrom || v.effectiveFrom <= today));
  if (latest?.id !== version.id) return '历史版本';
  return version.effectiveTo && version.effectiveTo <= today ? '已失效' : '当前有效';
}

export function KnowledgeManager({ selectedId: initialId, onBusy, onChanged }: { selectedId?: string; onBusy: (busy: boolean) => void; onChanged: () => void }) {
  const knowledge = useApi<KnowledgeVersion[]>('/api/modules/hr/knowledge');
  const metrics = useApi<Metrics>('/api/modules/hr/service-metrics');
  const [selectedId, setSelectedId] = useState(initialId ?? '');
  const [creating, setCreating] = useState(false);
  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = knowledge.data?.find((v) => v.id === selectedId);
  const refresh = () => { void knowledge.reload(); void metrics.reload(); onChanged(); };
  const setPending = (value: boolean) => { setBusy(value); onBusy(value); };
  async function archive(version: KnowledgeVersion) {
    setPending(true); setError('');
    try { await api('/api/modules/hr/knowledge/documents/' + version.documentId + '/archive', { method: 'POST', body: { archived: !version.archived } }); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }
  return <div className="space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-500">录入制度文本，核对适用范围后发布。助手每次提问只读取已发布、已生效的版本。</p>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => { setCreating(true); setRevising(false); setSelectedId(''); setError(''); }}>新增制度 / FAQ</button>
    </div>
    {metrics.data ? <div className="grid grid-cols-2 gap-2 lg:grid-cols-5" aria-label="制度助手使用统计">
      {[
        ['问答轮次', metrics.data.total], ['引用制度答复', metrics.data.answered], ['追问 / 转人工', metrics.data.clarify + ' / ' + metrics.data.handoff],
        ['FAQ 复用轮次', metrics.data.faqReuse], ['平均响应', metrics.data.averageLatencyMs === null ? '—' : (metrics.data.averageLatencyMs / 1000).toFixed(1) + ' 秒'],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-lg font-semibold text-slate-800">{value}</div></div>)}
    </div> : null}
    <p className="text-xs text-slate-400">按已保存的问答轮次统计，耗时由服务端记录。<button type="button" onClick={() => void metrics.reload()} className="ml-2 text-brand-700">刷新统计</button></p>
    {metrics.error || knowledge.error || error ? <p role="alert" className="text-sm text-red-700">{error || knowledge.error || metrics.error} <button type="button" onClick={refresh} className="underline">刷新</button></p> : null}
    {!knowledge.data && knowledge.loading ? <Spinner /> : null}
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <ul className="max-h-[600px] space-y-2 overflow-y-auto">
        {knowledge.data?.map((version) => <li key={version.id}><button type="button" disabled={busy}
          onClick={() => { setSelectedId(version.id); setCreating(false); setRevising(false); setError(''); }}
          className={cx('w-full rounded-lg border p-3 text-left disabled:opacity-50', selectedId === version.id ? 'border-brand-300 bg-brand-50' : 'border-slate-200')}>
          <span className="block text-sm font-medium text-slate-800">{version.title}</span>
          <span className="mt-1 block text-xs text-slate-500">{version.documentId} · v{version.version} · {version.kind === 'faq' ? 'FAQ' : '制度'} · {versionStatus(version, knowledge.data ?? [])}</span>
        </button></li>)}
      </ul>
      {creating || (selected && (revising || selected.status === 'draft') && !selected.archived)
        ? <KnowledgeEditor key={creating ? 'new' : selected!.id + ':' + selected!.revision + ':' + revising} version={creating ? undefined : selected}
            onBusy={setPending} onSaved={(version) => { setSelectedId(version.id); setCreating(false); setRevising(false); refresh(); }} />
        : selected ? <div className="space-y-3 rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900">{selected.title} · v{selected.version}</h3>
            <p className="text-xs text-slate-500">{selected.scope} · 生效：{selected.effectiveFrom ?? '历史演示制度未标注'} · 失效：{selected.effectiveTo ?? '未设置'}</p>
            {selected.publishedBy ? <p className="text-xs text-slate-500">发布人：{selected.publishedBy}</p> : null}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{selected.content}</p>
            <div className="flex gap-2">
              {!selected.archived ? <button type="button" disabled={busy} className={BUTTON} onClick={() => setRevising(true)}>新建修订草稿</button> : null}
              <button type="button" disabled={busy} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void archive(selected)}>{selected.archived ? '恢复制度' : '停用整份制度'}</button>
            </div>
          </div>
        : <Empty>选择制度查看版本，或新增内容。</Empty>}
    </div>
  </div>;
}

export function KnowledgeEditor({ version, sourceRequest, onBusy, onSaved }: {
  version?: KnowledgeVersion; sourceRequest?: FaqSource;
  onBusy: (busy: boolean) => void; onSaved: (version: KnowledgeVersion) => void;
}) {
  const initial = {
    title: version?.title ?? sourceRequest?.question ?? '', category: version?.category ?? (sourceRequest ? '员工服务' : ''),
    keywords: version?.keywords ?? '', content: version?.content ?? sourceRequest?.answer ?? '',
    scope: version?.scope ?? '全体员工', effectiveFrom: version?.effectiveFrom ?? new Date().toISOString().slice(0, 10), effectiveTo: version?.effectiveTo ?? '',
  };
  const [fields, setFields] = useState(initial);
  const [kind, setKind] = useState<'policy' | 'faq'>(version?.kind ?? (sourceRequest ? 'faq' : 'policy'));
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(initial) !== JSON.stringify(fields);
  const editableDraft = version?.status === 'draft';
  function change(key: keyof typeof fields, value: string) { setFields((old) => ({ ...old, [key]: value })); setReviewed(false); setError(''); }
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); onBusy(true); setError('');
    try {
      const values = { ...fields, effectiveTo: fields.effectiveTo || null };
      const result = await api<KnowledgeVersion>(editableDraft ? '/api/modules/hr/knowledge/' + version.id : '/api/modules/hr/knowledge', {
        method: editableDraft ? 'PATCH' : 'POST',
        body: editableDraft ? { ...values, revision: version.revision } : { ...values, kind, ...(version ? { documentId: version.documentId } : {}), ...(sourceRequest ? { sourceRequestId: sourceRequest.id } : {}) },
      });
      onSaved(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  async function publish() {
    if (!editableDraft || dirty || !reviewed) return;
    setBusy(true); onBusy(true); setError('');
    try {
      onSaved(await api<KnowledgeVersion>('/api/modules/hr/knowledge/' + version.id + '/publish', {
        method: 'POST', body: { revision: version.revision, reviewedForEmployees: true },
      }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  return <form onSubmit={save} className="space-y-3 rounded-lg border border-slate-200 p-4" aria-busy={busy}>
    <h3 className="font-medium text-slate-800">{sourceRequest ? '将人工答复整理为通用 FAQ' : editableDraft ? '编辑与审核草稿' : version ? '新建修订草稿' : '录入制度或 FAQ'}</h3>
    {sourceRequest ? <p className="text-xs text-amber-800">只保留通用问题和答复，移除姓名、个人工资等信息。保存后仍需到知识库审核发布。</p> : null}
    <fieldset disabled={busy} className="space-y-3">
      <label className="block text-sm text-slate-600">知识类型
        <select aria-label="知识类型" disabled={Boolean(version || sourceRequest)} value={kind} onChange={(e) => { setKind(e.target.value as 'policy' | 'faq'); setReviewed(false); }} className={FIELD}><option value="policy">公司制度</option><option value="faq">通用 FAQ</option></select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-slate-600">标题 / 通用问题<input required minLength={2} maxLength={160} value={fields.title} onChange={(e) => change('title', e.target.value)} className={FIELD} /></label>
        <label className="text-sm text-slate-600">分类<input required maxLength={60} value={fields.category} onChange={(e) => change('category', e.target.value)} className={FIELD} placeholder="例如：假期、考勤、员工服务" /></label>
      </div>
      <label className="block text-sm text-slate-600">{kind === 'faq' ? '同义问法（每行一种）' : '关键词（空格分隔）'}
        <textarea maxLength={2000} rows={2} value={fields.keywords} onChange={(e) => change('keywords', e.target.value)} className={FIELD} />
      </label>
      <label className="block text-sm text-slate-600">适用范围<input required maxLength={200} value={fields.scope} onChange={(e) => change('scope', e.target.value)} className={FIELD} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-slate-600">生效日期<input required type="date" value={fields.effectiveFrom} onChange={(e) => change('effectiveFrom', e.target.value)} className={FIELD} /></label>
        <label className="text-sm text-slate-600">失效日期（当天起不再适用）<input type="date" value={fields.effectiveTo} onChange={(e) => change('effectiveTo', e.target.value)} className={FIELD} /></label>
      </div>
      <label className="block text-sm text-slate-600">{kind === 'faq' ? '通用答复' : '制度正文'}
        <textarea required minLength={5} maxLength={20000} rows={8} value={fields.content} onChange={(e) => change('content', e.target.value)} className={FIELD} placeholder="粘贴制度原文，按段落或条款换行" />
      </label>
      <button type="submit" className={BUTTON}>保存草稿</button>
      {editableDraft ? <div className="space-y-2 border-t border-slate-100 pt-3">
        {dirty ? <p className="text-xs text-amber-700">内容已修改，请先保存草稿，再审核发布。</p> : null}
        <label className="flex items-start gap-2 text-sm text-slate-600"><input type="checkbox" className="mt-1" disabled={dirty} checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />我已核对内容与适用范围，确认可提供给公司内所有已登录账号</label>
        <button type="button" disabled={!reviewed || dirty} onClick={() => void publish()} className={BUTTON}>审核通过并发布</button>
      </div> : null}
    </fieldset>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
  </form>;
}
