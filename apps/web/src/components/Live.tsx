import type { AgentOSEvent, Signal, Situation } from '@agentos/shared';
import { ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { CHANNEL_LABELS, cx, DOMAIN_ICONS, DomainTag, Empty, LevelPill, SeverityBadge, Spinner, timeAgo, formatTime } from '../ui.tsx';

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
    <dd className={cx('num leading-none font-bold whitespace-nowrap', String(value).length > 6 ? 'text-[22px]' : 'text-[30px]', bad ? 'text-red-700' : 'text-slate-900')}>
      {value}
      {unit && <span className="ml-0.5 text-sm font-normal text-slate-500">{unit}</span>}
    </dd>
  );
}

export function SituationCard({ situation, flashing, signalCount }: { situation: Situation; flashing?: boolean; signalCount?: number }) {
  const Icon = DOMAIN_ICONS[situation.domain];
  const alert = situation.level === 'alert';
  return (
    <Link
      to={`/m/${situation.domain}`}
      className={cx(
        'group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-slate-300 hover:shadow-md',
        flashing && 'flash',
      )}
    >
      {alert ? <div className="hazard h-1.5" /> : <div className={cx('h-1.5', situation.level === 'watch' ? 'bg-watch' : 'bg-slate-200')} />}
      <div className="flex flex-1 flex-col gap-3.5 p-[18px]">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-slate-600" />
          <span className="text-[15px] font-bold text-slate-900">{situation.title}</span>
          <span className="ml-auto">
            <LevelPill level={situation.level} />
          </span>
        </div>
        <p className={cx('min-h-12 text-[17px] leading-snug font-bold', alert ? 'text-red-700' : 'text-slate-900')}>{situation.headline}</p>
        <dl className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
          {situation.metrics.map((m) => (
            <div key={m.label} className="flex min-w-0 flex-col gap-1">
              <dt className="truncate text-xs text-slate-500" title={m.label}>{m.label}</dt>
              <Reading value={m.value} unit={m.unit} bad={m.tone === 'bad'} />
            </div>
          ))}
        </dl>
        <div className="mt-auto flex items-center justify-between text-xs text-slate-600 group-hover:text-brand-600">
          <span>{signalCount ? `${signalCount} 条活跃信号` : '无活跃信号'}</span>
          <ChevronRight className="size-3.5" />
        </div>
      </div>
    </Link>
  );
}

export function EventRow({
  event,
  flashing,
  onStatus,
}: {
  event: AgentOSEvent;
  flashing?: boolean;
  onStatus?: (event: AgentOSEvent, status: AgentOSEvent['status']) => void;
}) {
  return (
    <li className={cx('flex gap-3 px-4 py-2.5', flashing && 'slide-in bg-red-50/60', event.status === 'resolved' && 'opacity-50')}>
      <SeverityBadge severity={event.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-slate-800">{event.title}</span>
          {event.count > 1 && <span className="rounded bg-slate-800 px-1.5 text-[11px] font-medium text-white">×{event.count}</span>}
        </div>
        {event.summary && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{event.summary}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <DomainTag domain={event.domain} />
          <span>{event.typeLabel}</span>
          <span>{CHANNEL_LABELS[event.source.channel] ?? event.source.channel}</span>
          {event.source.actor && <span>{event.source.actor}</span>}
          <span title={formatTime(event.lastSeenAt)}>{timeAgo(event.lastSeenAt)}</span>
          {event.status !== 'open' && <span>{event.status === 'acknowledged' ? '已确认' : '已解决'}</span>}
        </div>
      </div>
      {onStatus && event.status !== 'resolved' && (
        <div className="flex shrink-0 items-start gap-1">
          {event.status === 'open' && (
            <button onClick={() => onStatus(event, 'acknowledged')} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
              确认
            </button>
          )}
          <button onClick={() => onStatus(event, 'resolved')} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50">
            解决
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

/** Side drawer: a signal and the events it was built from. */
export function SignalDrawer({ signalId, onClose }: { signalId: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ signal: Signal; events: AgentOSEvent[] } | null>(null);
  useEffect(() => {
    setData(null);
    if (signalId) void api<{ signal: Signal; events: AgentOSEvent[] }>(`/api/signals/${signalId}`).then(setData);
  }, [signalId]);
  if (!signalId) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
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
          ) : (
            <Spinner className="text-slate-400" />
          )}
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
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
      </aside>
    </div>
  );
}
