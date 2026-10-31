import type { AgentOSEvent, Domain, ModuleOverview, Signal } from '@agentos/shared';
import { Bot } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../api.ts';
import { DataTable } from '../components/DataTable.tsx';
import { EventRow, SignalDrawer, SignalList, SituationCard, SituationSignalsDrawer, useFlash } from '../components/Live.tsx';
import { useLive, useSession } from '../session.tsx';
import { Card, DOMAIN_ICONS, Empty, Photo, reading, Section, Spinner } from '../ui.tsx';
const HrWorkbench = lazy(() => import('./hr/HrWorkbench.tsx').then((m) => ({ default: m.HrWorkbench })));

export function ModulePage() {
  const domain = useParams().domain as Domain;
  const { catalog } = useSession();
  const overview = useApi<ModuleOverview>(`/api/modules/${domain}/overview`);
  const signals = useApi<Signal[]>(`/api/signals?domain=${domain}`);
  const events = useApi<AgentOSEvent[]>(`/api/events?domain=${domain}&limit=30`);
  const { flashing, flash } = useFlash();
  const [signalId, setSignalId] = useState<string | null>(null);
  const [showSignals, setShowSignals] = useState(false);
  useEffect(() => { setSignalId(null); setShowSignals(false); }, [domain]);
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
    <div className="mx-auto max-w-[1360px] space-y-7 px-4 pt-5 pb-10 md:px-7 md:pt-6">
      <Photo src={`/photos/${domain}.jpg`} alt={`${module.name}现场`} className="rounded-[14px] text-white">
        <div className="relative flex flex-wrap items-end gap-4 bg-gradient-to-r from-ink-900/90 via-ink-900/75 to-ink-900/40 px-6 py-7 md:px-8">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand-600">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[11px] tracking-[0.14em] text-sky-300">MODULE · {domain.toUpperCase()}</span>
            <h1 className="mt-1 text-[26px] leading-tight font-bold">{module.name}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-300">{module.description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <Link key={a.id} to={a.companyService ? '/employee-service' : '/agents/' + a.id} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-white/30 bg-ink-900/40 px-3.5 text-sm hover:bg-white/15">
                <Bot className="size-4" />
                {a.name}
              </Link>
            ))}
          </div>
        </div>
      </Photo>

      <Section no="01" title="态势与指标" en="SITUATION">
        <div className="grid gap-4 lg:grid-cols-3">
          <SituationCard situation={situation} flashing={flashing(domain)} signalCount={signals.data?.length} onOpen={() => setShowSignals(true)} />
          <dl className="grid content-start grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-4">
            {metrics.map((m) => (
              <div key={m.label} className="flex min-h-28 flex-col justify-between gap-2 rounded-[10px] border border-slate-200 bg-white p-4">
                <dt className="text-xs text-slate-500">{m.label}</dt>
                <dd className="num text-[34px] leading-none font-bold text-slate-900">
                  {reading(m.value)}
                  {m.unit && <span className="ml-1 text-sm font-normal text-slate-500">{m.unit}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {domain === 'hr' ? <Suspense fallback={<Spinner />}><HrWorkbench onChanged={() => { void overview.reload(); void events.reload(); void signals.reload(); }} /></Suspense> : null}

      <div className="grid gap-7 xl:grid-cols-3 xl:gap-5">
        <Section no="02" title="业务数据" en="RECORDS" className="xl:col-span-2">
          <div className="space-y-5">
            {tables.filter((t) => domain !== 'hr' || t.title !== '员工服务请求').map((t) => (
              <Card key={t.title} title={t.title}>
                <DataTable table={t} />
              </Card>
            ))}
          </div>
        </Section>
        <Section no="03" title="信号与事件" en="SIGNALS">
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
        </Section>
      </div>
      <SignalDrawer signalId={signalId} onClose={() => setSignalId(null)} />
      <SituationSignalsDrawer open={showSignals} title={module.name} signals={signals.data ?? []} loading={signals.loading} error={signals.error} onClose={() => setShowSignals(false)} onOpen={id => { setShowSignals(false); setSignalId(id); }} />
    </div>
  );
}
