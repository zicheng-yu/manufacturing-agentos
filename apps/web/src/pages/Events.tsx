import { DOMAIN_LABELS, type AgentOSEvent } from '@agentos/shared';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { api, useApi } from '../api.ts';
import { EventRow, useFlash } from '../components/Live.tsx';
import { useLive, useSession } from '../session.tsx';
import { Card, Empty, Spinner } from '../ui.tsx';

const STATUS_OPTIONS = [
  ['unresolved', '未解决'],
  ['open', '待确认'],
  ['acknowledged', '已确认'],
  ['resolved', '已解决'],
  ['', '全部'],
] as const;
const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 } as const;

export function Events() {
  const { session } = useSession();
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState('unresolved');
  const [sort, setSort] = useState('recent');
  const query = new URLSearchParams({ limit: '200', sort, ...(domain && { domain }), ...(status && { status }) });
  const { data, setData, loading, error, reload } = useApi<AgentOSEvent[]>(`/api/events?${query}`);
  const [notice, setNotice] = useState<{ title: string; status: AgentOSEvent['status']; renewed: boolean } | null>(null);
  const [renewedId, setRenewedId] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const { flashing, flash } = useFlash();
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), [reload]);

  useLive((message) => {
    if (message.kind !== 'event.created' && message.kind !== 'event.updated') return;
    if (domain && message.event.domain !== domain) return;
    if (message.event.status !== 'resolved') flash(message.event.id);
    // Requery before limiting, so an older urgent event is not displaced by a recent low-priority one.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 200);
  });

  async function setEventStatus(event: AgentOSEvent, next: AgentOSEvent['status']) {
    const { activeEvent, ...updated } = await api<AgentOSEvent & { activeEvent?: AgentOSEvent }>(`/api/events/${event.id}`, { method: 'PATCH', body: { status: next } });
    window.clearTimeout(timer.current);
    setNotice({ title: event.title, status: next, renewed: !!activeEvent });
    setRenewedId(activeEvent?.id ?? null);
    // Apply the confirmed response immediately; the background reload then fills any gap in the 200-row window.
    setData(prev => {
      if (!prev) return prev;
      const rows = prev.map(e => e.id === updated.id ? updated : e);
      if (activeEvent && !rows.some(e => e.id === activeEvent.id)) rows.push(activeEvent);
      return rows.filter(e => (!domain || e.domain === domain) && (!status || (status === 'unresolved' ? e.status !== 'resolved' : e.status === status)))
        .sort((a, b) => (!status ? Number(a.status === 'resolved') - Number(b.status === 'resolved') : 0) || (sort === 'severity' ? SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] : 0) || b.lastSeenAt.localeCompare(a.lastSeenAt) || b.id.localeCompare(a.id)).slice(0, 200);
    });
    if (activeEvent) flash(activeEvent.id);
    await reload();
  }

  const select = 'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm';
  return (
    <div ref={top} className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">事件中心</h1>
        <p className="text-sm text-slate-500">来自智能体、仿真事件桥与演示回放的全部一线事件；同类重复事件自动合并计数</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="模块筛选" value={domain} onChange={(e) => setDomain(e.target.value)} className={select}>
          <option value="">全部模块</option>
          {session?.domains.map((d) => (
            <option key={d} value={d}>
              {DOMAIN_LABELS[d]}
            </option>
          ))}
        </select>
        <select aria-label="状态筛选" value={status} onChange={(e) => setStatus(e.target.value)} className={select}>
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value)} className={select}>
          <option value="recent">按最近更新排序</option>
          <option value="severity">按紧急程度排序（严重 → 警告 → 提示）</option>
        </select>
        {loading && <Spinner className="mt-2 text-slate-400" />}
      </div>
      <p className="text-xs text-slate-500">当前显示 {data?.length ?? 0} 项{!status ? ' · 已解决事项排在末尾' : status === 'unresolved' ? ' · 解决后自动移出此列表' : ''}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Card>
        {data?.length ? (
          <ul className="divide-y divide-slate-100">
            {data.map((e) => (
              <EventRow key={e.id} event={e} flashing={flashing(e.id)} renewed={renewedId === e.id} onStatus={setEventStatus} />
            ))}
          </ul>
        ) : (
          <Empty>{loading ? '正在加载事件…' : '没有符合条件的事件'}</Empty>
        )}
      </Card>
      {notice && <div role="status" aria-live="polite" className={`fixed right-4 bottom-4 z-50 max-w-md rounded-xl border bg-white p-4 shadow-lg ${notice.renewed ? 'border-amber-300' : 'border-emerald-300'}`}>
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-700" />
          <p className="text-sm font-medium">{notice.renewed ? '已关闭原记录' : notice.status === 'resolved' ? '已解决' : '已确认'}：{notice.title}</p>
          <button aria-label="关闭操作提示" onClick={() => setNotice(null)} className="ml-2 rounded p-1 text-slate-500 hover:bg-slate-100"><X className="size-4" /></button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-600">{notice.renewed ? '业务数据仍显示该问题，系统已生成并标记一条新预警，需要继续处理。' : notice.status === 'resolved' ? '已从未解决列表移除；在全部列表中排到末尾，可在“已解决”中查看。' : '处理状态已更新，仍保留在未解决列表中。'}</p>
        {notice.status === 'resolved' && <button className="mt-2 text-xs font-medium text-brand-700 hover:underline" onClick={() => { setStatus(notice.renewed ? 'unresolved' : 'resolved'); top.current?.scrollIntoView({ behavior: 'smooth' }); }}>{notice.renewed ? '查看未解决事项' : '查看已解决事项'}</button>}
      </div>}
    </div>
  );
}
