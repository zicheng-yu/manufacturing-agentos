import type { AgentOSEvent, Domain, ModuleOverview, Signal } from '@agentos/shared';
import { Bot } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../api.ts';
import { DataTable } from '../components/DataTable.tsx';
import { EventRow, SignalDrawer, SignalList, SituationCard, useFlash } from '../components/Live.tsx';
import { useLive, useSession } from '../session.tsx';
import { Card, DOMAIN_ICONS, Empty, Spinner } from '../ui.tsx';

export function ModulePage() {
  const domain = useParams().domain as Domain;
  const { catalog } = useSession();
  const overview = useApi<ModuleOverview>(`/api/modules/${domain}/overview`);
  const signals = useApi<Signal[]>(`/api/signals?domain=${domain}`);
  const events = useApi<AgentOSEvent[]>(`/api/events?domain=${domain}&limit=30`);
  const { flashing, flash } = useFlash();
  const [signalId, setSignalId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLive((message) => {
    const messageDomain =
      'event' in message ? message.event.domain : 'signal' in message ? message.signal.domain : 'situation' in message ? message.situation.domain : message.task.domain;
    if (messageDomain !== domain) return;
    if ('event' in message) flash(message.event.id);
    if ('situation' in message) flash(domain);
    if ('signal' in message) flash(message.signal.id);
    // Module data (tables, metrics) may have changed too; reload once the burst settles.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void overview.reload();
      void signals.reload();
      void events.reload();
    }, 400);
  });

  if (overview.error) return <p className="p-6 text-sm text-red-600">{overview.error}</p>;
  if (!overview.data) return <div className="flex justify-center p-12 text-slate-400"><Spinner /></div>;
  const { module, situation, metrics, tables } = overview.data;
  const Icon = DOMAIN_ICONS[domain];
  const agents = catalog?.agents.filter((a) => a.module === domain) ?? [];

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-white">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-slate-900">{module.name}</h1>
          <p className="text-sm text-slate-500">{module.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {agents.map((a) => (
            <Link key={a.id} to={`/agents/${a.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand-300 hover:text-brand-700">
              <Bot className="size-4" />
              {a.name}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SituationCard situation={situation} flashing={flashing(domain)} signalCount={signals.data?.length} />
        <div className="grid grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs text-slate-500">{m.label}</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
                {m.value}
                {m.unit && <span className="ml-1 text-sm font-normal text-slate-400">{m.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          {tables.map((t) => (
            <Card key={t.title} title={t.title}>
              <DataTable table={t} />
            </Card>
          ))}
        </div>
        <div className="space-y-5">
          <Card title="活跃信号">
            <SignalList signals={signals.data ?? []} flashing={flashing} onOpen={setSignalId} />
          </Card>
          <Card title="最近事件">
            {events.data?.length ? (
              <ul className="max-h-[640px] divide-y divide-slate-100 overflow-y-auto">
                {events.data.map((e) => (
                  <EventRow key={e.id} event={e} flashing={flashing(e.id)} />
                ))}
              </ul>
            ) : (
              <Empty>暂无事件</Empty>
            )}
          </Card>
        </div>
      </div>
      <SignalDrawer signalId={signalId} onClose={() => setSignalId(null)} />
    </div>
  );
}
