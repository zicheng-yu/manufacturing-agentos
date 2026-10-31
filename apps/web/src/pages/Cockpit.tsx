import type { AgentOSEvent, Cockpit as CockpitData, Signal, StreamMessage, TableArtifact, Task, Turn } from '@agentos/shared';
import { DOMAIN_LABELS } from '@agentos/shared';
import { ArrowRight, CheckSquare, ChevronDown, Clock, Link2, Radio, RefreshCw, Sparkles, Square, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../api.ts';
import { EventRow, SignalDrawer, SignalList, SituationCard, useFlash } from '../components/Live.tsx';
import { Answer, Evidence } from '../components/ResultView.tsx';
import { useLive, useSession } from '../session.tsx';
import { Card, cx, DomainTag, Empty, Lamp, Photo, Section, Spinner, formatTime } from '../ui.tsx';

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 } as const;

function sortSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.lastAt.localeCompare(a.lastAt));
}

function apply(data: CockpitData, message: StreamMessage): CockpitData {
  switch (message.kind) {
    case 'situation.updated':
      return { ...data, situations: data.situations.map((s) => (s.domain === message.situation.domain ? message.situation : s)) };
    case 'signal.raised':
    case 'signal.updated':
      return { ...data, signals: sortSignals([message.signal, ...data.signals.filter((s) => s.id !== message.signal.id)]) };
    case 'signal.cleared':
      return { ...data, signals: data.signals.filter((s) => s.id !== message.signal.id) };
    case 'event.created':
    case 'event.updated':
      return { ...data, events: [message.event, ...data.events.filter((e) => e.id !== message.event.id)].slice(0, 40) };
    case 'task.created':
      return { ...data, tasks: [message.task, ...data.tasks.filter((t) => t.id !== message.task.id)] };
  }
}

function flashKey(message: StreamMessage): string {
  switch (message.kind) {
    case 'situation.updated':
      return message.situation.domain;
    case 'signal.raised':
    case 'signal.updated':
    case 'signal.cleared':
      return message.signal.id;
    case 'event.created':
    case 'event.updated':
      return message.event.id;
    case 'task.created':
      return message.task.id;
  }
}

/** Lead sentence of the model's answer, without markdown decoration. */
function leadOf(markdown: string): string {
  const line = markdown.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|') && !l.startsWith('#')) ?? '';
  return line.replace(/^\*\*|\*\*$/g, '').replace(/^结论[:：]\s*/, '');
}

function DecisionCards({ table }: { table: TableArtifact }) {
  const col = (name: string) => table.columns.indexOf(name);
  return (
    <ol className="grid gap-3 lg:grid-cols-3">
      {table.rows.map((row) => (
        <li key={String(row[0])} className="flex flex-col rounded-[10px] border border-slate-200 bg-slate-50 p-3.5">
          <div className="flex items-start gap-2.5">
            <span className="num shrink-0 text-[26px] leading-none font-bold text-brand-600">{String(row[0]).padStart(2, '0')}</span>
            <p className="text-sm leading-snug font-bold text-slate-900">{row[col('待决事项')]}</p>
          </div>
          <p className="mt-2 flex-1 text-xs leading-relaxed text-slate-600">{row[col('影响')]}</p>
          <div className="mt-3 space-y-1 text-[11px]">
            <div className="flex gap-1.5 text-slate-700">
              <UserRound className="mt-px size-3.5 shrink-0 text-slate-400" />
              {row[col('建议负责人')]}
            </div>
            <div className="flex gap-1.5 text-slate-700">
              <Clock className="mt-px size-3.5 shrink-0 text-slate-400" />
              {row[col('建议完成时间')]}
            </div>
            <div className="flex gap-1.5 text-red-700">
              <Radio className="mt-px size-3.5 shrink-0 text-red-600" />
              {row[col('依据信号')]}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Briefing({ turn, onRun, running, executive }: { turn: Turn | null; onRun: () => void; running: boolean; executive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const decisions = turn?.result.artifacts.find((a) => a.title === '今日决策简报');
  // Link facts read "FPC-1203：供应链「…」；品质「…」" or mention 叠加; per-signal details start with a module name.
  const links = turn?.result.facts.filter((f) => /^[^「]+：.*「|叠加/.test(f)) ?? [];
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand-600" />
          决策简报
          {turn && (
            <span className="text-xs font-normal text-slate-400">
              {formatTime(turn.createdAt)} · {turn.mode === 'llm' ? '模型撰写' : '规则分析'} · {(turn.latencyMs / 1000).toFixed(1)} 秒
            </span>
          )}
        </span>
      }
      action={
        executive && (
          <button
            onClick={onRun}
            disabled={running}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-[13px] font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {running ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            {turn ? '重新生成' : '生成今日决策简报'}
          </button>
        )
      }
    >
      {running && !turn && (
        <div className="flex items-center gap-2 px-4 py-8 text-sm text-slate-500">
          <Spinner className="text-brand-600" /> 经营决策助手正在读取各模块的态势、信号与共享记忆…
        </div>
      )}
      {!running && !turn && <Empty>{executive ? '点击右上角，让经营决策助手给出今天最需要决定的事' : '仅董事长可生成决策简报'}</Empty>}
      {turn && (
        <div className={cx('space-y-4 p-4', running && 'opacity-50')}>
          <div>
            <h3 className="text-base font-semibold text-slate-900">{turn.result.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{leadOf(turn.result.answer)}</p>
          </div>
          {decisions && <DecisionCards table={decisions} />}
          {links.length > 0 && (
            <div className="rounded-[10px] border border-[#f5d27a] bg-[#fff8e6] p-3">
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] tracking-[0.12em] text-watch-ink">
                <Link2 className="size-3.5" />
                跨部门关联 · LINKS
              </div>
              <ul className="space-y-1 text-[13px] leading-relaxed text-slate-900">
                {links.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          <button onClick={() => setExpanded((v) => !v)} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
            <ChevronDown className={cx('size-3.5 transition', expanded && 'rotate-180')} />
            {expanded ? '收起完整分析' : '查看完整分析与依据'}
          </button>
          {expanded && (
            <div className="space-y-4 border-t border-slate-100 pt-4">
              <Answer markdown={turn.result.answer} />
              <Evidence result={turn.result} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function Cockpit() {
  const { session } = useSession();
  const { data, setData, error } = useApi<CockpitData>('/api/cockpit');
  const { flashing, flash } = useFlash();
  const [signalId, setSignalId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const executive = session?.account.role === 'executive';

  useLive((message) => {
    setData((prev) => (prev ? apply(prev, message) : prev));
    if (message.kind !== 'signal.cleared') flash(flashKey(message));
  });

  async function runBriefing() {
    setRunning(true);
    try {
      const { turn } = await api<{ turn: Turn }>('/api/cockpit/briefing', { method: 'POST' });
      setData((prev) => (prev ? { ...prev, briefing: turn } : prev));
    } finally {
      setRunning(false);
    }
  }

  async function setEventStatus(event: AgentOSEvent, status: AgentOSEvent['status']) {
    await api(`/api/events/${event.id}`, { method: 'PATCH', body: { status } });
  }

  async function toggleTask(task: Task) {
    const status = task.status === 'open' ? 'done' : 'open';
    await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status } });
    setData((prev) => (prev ? { ...prev, tasks: prev.tasks.map((t) => (t.id === task.id ? { ...t, status } : t)) } : prev));
  }

  if (error) return <p className="p-6 text-sm text-red-600">{error}</p>;
  if (!data) return <div className="flex justify-center p-12 text-slate-400"><Spinner /></div>;

  const signalCount = (domain: string) => data.signals.filter((s) => s.domain === domain).length;

  const alerting = data.situations.filter((x) => x.level === 'alert');
  const openTasks = data.tasks.filter((t) => t.status === 'open').length;

  return (
    <div className="mx-auto max-w-[1360px] space-y-7 px-4 pt-5 pb-10 md:px-7 md:pt-6">
      <Photo src="/photos/hero.jpg" alt="工厂产线实景" className="flex min-h-[300px] flex-wrap rounded-[14px] text-white">
        <div className="relative flex flex-[3_1_480px] flex-col gap-4 bg-ink-900/80 px-6 py-8 md:px-10 md:py-9">
          <span className="font-mono text-[11px] tracking-[0.14em] text-sky-300">{session?.company.shortName ?? ''} · FACTORY OPERATIONS</span>
          <h1 className="text-[30px] leading-tight font-bold md:text-4xl">
            厂区经营态势 <span className="text-sky-300">·</span> 实时
          </h1>
          <p className="max-w-[540px] text-sm leading-relaxed text-slate-300">
            设备读数、AGV 任务和一线事件实时上报，按规则聚合为经理层信号，再汇总为下方 {data.situations.length} 张态势卡。点击任意卡片或信号，可以下钻到原始事件。
          </p>
          <div className="mt-1 flex flex-wrap gap-2.5">
            <a href="#signals" className="inline-flex h-11 items-center gap-2 rounded-lg bg-white px-4.5 text-sm font-semibold text-ink-900 hover:bg-slate-100">
              查看活跃信号 <ArrowRight className="size-4" />
            </a>
            <Link to="/events" className="inline-flex h-11 items-center rounded-lg border border-white/35 px-4.5 text-sm hover:bg-white/10">
              打开事件中心
            </Link>
          </div>
          <span className="mt-auto pt-2 text-[11px] text-slate-400">{session?.company.demoNotice}</span>
        </div>
        <div className="relative flex flex-[2_1_320px] items-center justify-center p-6">
          <div className="flex w-full max-w-[360px] flex-col gap-3.5 rounded-xl bg-brand-600 p-5.5">
            <span className="font-mono text-[11px] tracking-[0.12em] text-brand-100">各模块态势 · 已上卷</span>
            <div className="flex items-baseline gap-2.5">
              <span className="num text-[64px] leading-none font-bold">
                {alerting.length}
                <span className="text-[32px] text-brand-100"> / {data.situations.length}</span>
              </span>
              <span className="text-sm">模块告警</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {data.situations.map((x) => (
                <Link key={x.domain} to={`/m/${x.domain}`} className="flex items-center gap-2 rounded-lg bg-white/12 px-2.5 py-2 text-[13px] hover:bg-white/20">
                  <Lamp level={x.level} />
                  {DOMAIN_LABELS[x.domain]}
                </Link>
              ))}
            </div>
            {executive && (
              <button
                onClick={() => {
                  void runBriefing();
                  document.getElementById('briefing')?.scrollIntoView({ behavior: 'smooth' });
                }}
                disabled={running}
                className="flex h-11 items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-ink-900 hover:bg-slate-100 disabled:opacity-70"
              >
                {running ? <Spinner className="size-4" /> : <Sparkles className="size-4" />}
                生成今日决策简报
              </button>
            )}
          </div>
        </div>
      </Photo>

      <Section no="01" title="全局态势" en="SITUATION">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.situations.map((s) => (
            <SituationCard key={s.domain} situation={s} flashing={flashing(s.domain)} signalCount={signalCount(s.domain)} />
          ))}
        </div>
      </Section>

      <div className="grid gap-7 xl:grid-cols-3 xl:gap-5">
        <Section no="02" title="今日决策" en="DECISIONS" className="xl:col-span-2">
          <div id="briefing" className="scroll-mt-4">
            <Briefing turn={data.briefing} onRun={() => void runBriefing()} running={running} executive={executive} />
          </div>
        </Section>
        <Section no="03" title={`活跃信号`} en="SIGNALS" action={<span className="num text-xl font-bold text-slate-900">×{data.signals.length}</span>}>
          <div id="signals" className="scroll-mt-4">
            <Card>
              <SignalList signals={data.signals} flashing={flashing} onOpen={setSignalId} />
            </Card>
          </div>
        </Section>
      </div>

      <div className="grid gap-7 xl:grid-cols-3 xl:gap-5">
        <Section no="04" title="实时事件流" en="EVENT STREAM" className="xl:col-span-2">
          <Card>
            {data.events.length ? (
              <ul className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">
                {data.events.map((e) => (
                  <EventRow key={e.id} event={e} flashing={flashing(e.id)} onStatus={setEventStatus} />
                ))}
              </ul>
            ) : (
              <Empty>暂无事件</Empty>
            )}
          </Card>
        </Section>
        <Section no="05" title="待办" en="TASKS" action={<span className="num text-xl font-bold text-slate-900">×{openTasks}</span>}>
          <Card>
            {data.tasks.length ? (
              <ul className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">
                {data.tasks.map((t) => (
                  <li key={t.id} className={`flex gap-2.5 px-4 py-2.5 ${flashing(t.id) ? 'slide-in bg-brand-50' : ''}`}>
                    <button onClick={() => void toggleTask(t)} aria-label={t.status === 'done' ? '标记为未完成' : '标记为已完成'} className="mt-0.5 text-slate-400 hover:text-brand-600">
                      {t.status === 'done' ? <CheckSquare className="size-4 text-green-700" /> : <Square className="size-4" />}
                    </button>
                    <div className={`min-w-0 flex-1 ${t.status === 'done' ? 'line-through opacity-50' : ''}`}>
                      <div className="text-sm text-slate-800">{t.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                        <DomainTag domain={t.domain} />
                        {t.owner && <span>{t.owner}</span>}
                        {t.due && <span className="font-mono">截止 {t.due}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>暂无待办</Empty>
            )}
          </Card>
        </Section>
      </div>

      <SignalDrawer signalId={signalId} onClose={() => setSignalId(null)} />
    </div>
  );
}
