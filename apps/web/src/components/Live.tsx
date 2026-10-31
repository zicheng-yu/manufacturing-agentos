import type { AgentOSEvent, Signal, Situation } from '@agentos/shared';
import { ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { CHANNEL_LABELS, cx, reading, DOMAIN_ICONS, DomainTag, Empty, LevelPill, SeverityBadge, Spinner, timeAgo, formatTime } from '../ui.tsx';

/** Remember which keys changed recently so the UI can highlight them. */
export function useFlash(ms = 2600) {
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, number>());
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const flash = useCallback(
    (key: string) => {
      setKeys((prev) => new Set(prev).add(key));
      window.clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        window.setTimeout(() => {
          setKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }, ms),
      );
    },
    [ms],
  );
  return { flashing: (key: string) => keys.has(key), flash };
}

/** A metric set like a gauge reading: condensed figure, small unit. */
function Reading({ value, unit, bad }: { value: string | number; unit?: string; bad: boolean }) {
  return (
    <dd data-long={reading(value).length > 6} className={cx('metric-reading num flex min-w-0 flex-wrap items-baseline leading-none font-bold', bad ? 'text-red-700' : 'text-slate-900')}>
      {reading(value)}
      {unit && <span className="ml-0.5 text-sm font-normal text-slate-500">{unit}</span>}
    </dd>
  );
}

export function SituationCard({ situation, flashing, signalCount, linkToModule = true }: { situation: Situation; flashing?: boolean; signalCount?: number; linkToModule?: boolean }) {
  const Icon = DOMAIN_ICONS[situation.domain];
  const alert = situation.level === 'alert';
  const className = cx('situation-card flex min-w-0 w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left', linkToModule && 'group cursor-pointer transition hover:border-slate-300 hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-600', flashing && 'flash');
  const content = <>
      {alert ? <div className="hazard h-1.5" /> : <div className={cx('h-1.5', situation.level === 'watch' ? 'bg-watch' : 'bg-slate-200')} />}
      <div className="flex flex-1 flex-col gap-3.5 p-[18px]">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-slate-600" />
          <span className="min-w-0 text-[15px] font-bold text-slate-900">{situation.title}</span>
          <span className="ml-auto shrink-0">
            <LevelPill level={situation.level} />
          </span>
        </div>
        <p className={cx('line-clamp-2 min-h-[2lh] text-[17px] leading-snug font-bold', alert ? 'text-red-700' : 'text-slate-900')}>{situation.headline}</p>
        <dl className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
          {situation.metrics.map((m) => (
            <div key={m.label} className="flex min-w-0 flex-col gap-1">
              <dt className="truncate text-xs text-slate-500" title={m.label}>{m.label}</dt>
              <Reading value={m.value} unit={m.unit} bad={m.tone === 'bad'} />
            </div>
          ))}
        </dl>
        <div className="mt-auto flex items-center justify-between text-xs text-slate-600 group-hover:text-brand-600">
          <span>{signalCount === undefined ? '活跃信号加载中' : signalCount ? `${signalCount} 条活跃信号` : '无活跃信号'}</span>
          {linkToModule && <span className="inline-flex items-center gap-1">查看模块<ChevronRight className="size-3.5" /></span>}
        </div>
      </div>
    </>;
  return linkToModule
    ? <Link to={`/m/${situation.domain}`} aria-label={`查看${situation.title}模块`} className={className}>{content}</Link>
    : <div className={className}>{content}</div>;
}

export function EventRow({
  event,
  flashing,
  onStatus,
}: {
  event: AgentOSEvent;
  flashing?: boolean;
  onStatus?: (event: AgentOSEvent, status: AgentOSEvent['status']) => void | Promise<void>;
}) {
  const [pending, setPending] = useState<AgentOSEvent['status'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function changeStatus(next: AgentOSEvent['status']) {
    if (!onStatus || pending) return;
    setPending(next);
    setError(null);
    try { await onStatus(event, next); }
    catch (e) { setError((e as Error).message || '操作失败，请重试'); }
    finally { setPending(null); }
  }
  return (
    <li id={`event-${event.id}`} aria-busy={!!pending} className={cx('flex flex-wrap gap-3 px-4 py-2.5 transition-colors sm:flex-nowrap', flashing && 'slide-in bg-red-50/60', event.status === 'resolved' && 'bg-slate-50')}>
      <SeverityBadge severity={event.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-slate-800">{event.title}</span>
          {event.count > 1 && <span className="rounded bg-slate-800 px-1.5 text-[11px] font-medium text-white">×{event.count}</span>}
          {event.status === 'resolved' && <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">✓ 已解决</span>}
          {event.status !== 'resolved' && typeof event.payload.reopenedFromEventId === 'string' && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">问题仍存在 · 新预警</span>}
        </div>
        {event.summary && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{event.summary}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <DomainTag domain={event.domain} />
          <span>{event.typeLabel}</span>
          <span>{CHANNEL_LABELS[event.source.channel] ?? event.source.channel}</span>
          {event.source.actor && <span>{event.source.actor}</span>}
          <span title={formatTime(event.lastSeenAt)}>{timeAgo(event.lastSeenAt)}</span>
          {event.status === 'acknowledged' && <span>已确认</span>}
        </div>
        {error && <p role="alert" className="mt-1 text-xs text-red-700">操作失败：{error}，请重试。</p>}
      </div>
      {onStatus && event.status !== 'resolved' && (
        <div className="flex w-full shrink-0 items-start justify-end gap-1 sm:w-auto">
          {event.status === 'open' && (
            <button disabled={!!pending} onClick={() => void changeStatus('acknowledged')} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {pending === 'acknowledged' ? '确认中…' : '确认'}
            </button>
          )}
          <button disabled={!!pending} onClick={() => void changeStatus('resolved')} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {pending === 'resolved' ? '解决中…' : '解决'}
          </button>
        </div>
      )}
    </li>
  );
}

export function SignalList({ signals, flashing, onOpen }: { signals: Signal[]; flashing?: (id: string) => boolean; onOpen: (id: string) => void }) {
  if (signals.length === 0) return <Empty>暂无活跃信号</Empty>;
  return (
    <ul className="divide-y divide-slate-100">
      {signals.map((s) => (
        <li key={s.id}>
          <button onClick={() => onOpen(s.id)} className={cx('flex w-full gap-3 px-4 py-2.5 text-left hover:bg-slate-50', flashing?.(s.id) && 'slide-in bg-red-50')}>
            <SeverityBadge severity={s.severity} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-800">{s.title}</div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-500">{s.summary}</p>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                <DomainTag domain={s.domain} />
                <span>{s.eventIds.length} 个事件 · 累计 {s.count} 次</span>
                <span>{timeAgo(s.lastAt)}</span>
              </div>
            </div>
            <ChevronRight className="mt-1 size-4 shrink-0 text-slate-300" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Native modal keeps focus inside the drawer and supports Escape and backdrop dismissal. */
function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} aria-label={label} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-md border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/30">
    <aside className="h-full overflow-y-auto">{children}</aside>
  </dialog>;
}

/** Side drawer: a signal and the events it was built from. */
export function SignalDrawer({ signalId, onClose }: { signalId: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ signal: Signal; events: AgentOSEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    if (signalId) void api<{ signal: Signal; events: AgentOSEvent[] }>(`/api/signals/${signalId}`).then(result => { if (current) setData(result); }).catch(e => { if (current) setError((e as Error).message); });
    return () => { current = false; };
  }, [signalId]);
  if (!signalId) return null;
  return (
    <Drawer label="信号详情" onClose={onClose}>
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
          {data ? (
            <div>
              <div className="flex items-center gap-2">
                <SeverityBadge severity={data.signal.severity} />
                <DomainTag domain={data.signal.domain} />
              </div>
              <h3 className="mt-2 text-base font-semibold text-slate-900">{data.signal.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{data.signal.summary}</p>
            </div>
          ) : error ? <p role="alert" className="text-sm text-red-600">{error}</p> : (
            <Spinner className="text-slate-400" />
          )}
          <button autoFocus aria-label="关闭信号详情" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>
        {data && (
          <>
            <p className="px-4 pt-3 text-xs text-slate-500">
              由以下 {data.events.length} 个事件按规则聚合而来（可回溯）
            </p>
            <ul className="divide-y divide-slate-100">
              {data.events.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ul>
          </>
        )}
    </Drawer>
  );
}
