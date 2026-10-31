import { DOMAIN_LABELS, type AgentOSEvent } from '@agentos/shared';
import { useEffect, useRef, useState } from 'react';
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

export function Events() {
  const { session } = useSession();
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState('unresolved');
  const [sort, setSort] = useState('recent');
  const query = new URLSearchParams({ limit: '200', sort, ...(domain && { domain }), ...(status && { status }) });
  const { data, loading, error, reload } = useApi<AgentOSEvent[]>(`/api/events?${query}`);
  const { flashing, flash } = useFlash();
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), [reload]);

  useLive((message) => {
    if (message.kind !== 'event.created' && message.kind !== 'event.updated') return;
    if (domain && message.event.domain !== domain) return;
    flash(message.event.id);
    // Requery before limiting, so an older urgent event is not displaced by a recent low-priority one.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 200);
  });

  async function setEventStatus(event: AgentOSEvent, next: AgentOSEvent['status']) {
    await api<AgentOSEvent>(`/api/events/${event.id}`, { method: 'PATCH', body: { status: next } });
    await reload();
  }

  const select = 'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm';
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
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
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Card>
        {data?.length ? (
          <ul className="divide-y divide-slate-100">
            {data.map((e) => (
              <EventRow key={e.id} event={e} flashing={flashing(e.id)} onStatus={(ev, st) => void setEventStatus(ev, st)} />
            ))}
          </ul>
        ) : (
          <Empty>没有符合条件的事件</Empty>
        )}
      </Card>
    </div>
  );
}
