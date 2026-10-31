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
/** Signals and the event/task feed share one height. */
const PANEL = 'flex h-[480px] flex-col overflow-hidden xl:h-[560px]';

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
            <div className="flex gap-1.5 text-alert-ink">
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
      {!running && !turn && (
        <p className="px-4 py-4 text-sm text-slate-500">
          {executive ? '经营决策助手会读取各模块的态势、活跃信号与共享记忆，列出今天最需要决定的三件事：影响、建议负责人、完成时间与依据信号。' : '仅董事长可生成决策简报'}
        </p>
      )}
      {turn && (
        <div className={cx('space-y-4 p-4', running && 'opacity-50')}>
          <div>
            <h3 className="text-base font-semibold text-slate-900">{turn.result.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{leadOf(turn.result.answer)}</p>
          </div>
          {decisions && <DecisionCards table={decisions} />}
          {links.length > 0 && (
            <div className="rounded-[10px] border border-watch-line bg-watch-soft p-3">
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
  const [feed, setFeed] = useState<'events' | 'tasks'>('events');
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
  const unresolved = data.events.filter((e) => e.status !== 'resolved').length;

  return (
    <div className="mx-auto max-w-[1360px] space-y-7 px-4 pt-5 pb-10 md:px-7 md:pt-6">
      <Photo src="/photos/hero.jpg" alt="工厂产线实景" className="flex min-h-[300px] flex-wrap rounded-[14px] text-white">
        <div className="relative flex flex-[3_1_480px] flex-col gap-4 bg-ink-900/80 px-6 py-8 md:px-10 md:py-9">
          <span className="font-mono text-[11px] tracking-[0.14em] text-brand-300">{session?.company.shortName ?? ''} · FACTORY OPERATIONS</span>
          <h1 className="text-[30px] leading-tight font-bold md:text-4xl">
            厂区经营态势 <span className="text-brand-300">·</span> 实时
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
          <div className="flex w-full max-w-[360px] flex-col gap-3.5 rounded-xl border border-slate-200 bg-white p-5.5 text-slate-900 shadow-lg">
            <span className="font-mono text-[11px] tracking-[0.12em] text-slate-500">各模块态势 · 已上卷</span>
            <div className="flex items-baseline gap-2.5">
              <span className={cx('num text-[64px] leading-none font-bold', alerting.length ? 'text-alert-ink' : 'text-slate-900')}>
                {alerting.length}
                <span className="text-[32px] text-slate-400"> / {data.situations.length}</span>
              </span>
              <span className="text-sm text-slate-600">严重风险模块</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {data.situations.map((x) => (
                <Link key={x.domain} to={`/m/${x.domain}`} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-[13px] text-slate-800 hover:border-slate-300 hover:bg-slate-100">
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
                className="flex h-11 items-center justify-center gap-2 rounded-lg bg-brand-600 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-70"
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

      <Section no="02" title="今日决策" en="DECISIONS">
        <div id="briefing" className="scroll-mt-4">
          <Briefing turn={data.briefing} onRun={() => void runBriefing()} running={running} executive={executive} />
        </div>
      </Section>

      {/* Side by side at one fixed height, each list scrolling inside its panel, so neither column leaves a gap. */}
      <div className="grid gap-7 xl:grid-cols-2 xl:gap-5">
        <Section no="03" title="活跃信号" en="SIGNALS" action={<span className="num text-xl font-bold text-slate-900">×{data.signals.length}</span>}>
          <div id="signals" className="scroll-mt-4">
            <Card className={PANEL}>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SignalList signals={data.signals} flashing={flashing} onOpen={setSignalId} />
              </div>
            </Card>
          </div>
        </Section>
        <Section no="04" title="事件与待办" en="EVENTS · TASKS">
          <Card className={PANEL}>
            <div role="tablist" aria-label="事件与待办" className="flex shrink-0 gap-1 border-b border-slate-100 px-2">
              {([['events', '实时事件', unresolved, '未解决'], ['tasks', '待办', openTasks, '未完成']] as const).map(([key, label, count, unit]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={feed === key}
                  onClick={() => setFeed(key)}
                  className={cx('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm', feed === key ? 'border-brand-600 font-bold text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800')}
                >
                  {label}
                  <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium', count ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500')}>
                    {count} {unit}
                  </span>
                </button>
              ))}
            </div>
            <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
              {feed === 'events' ? (
                data.events.length ? (
                  <ul className="divide-y divide-slate-100">
                    {data.events.map((e) => (
                      <EventRow key={e.id} event={e} flashing={flashing(e.id)} onStatus={setEventStatus} />
                    ))}
                  </ul>
                ) : (
                  <Empty>暂无事件</Empty>
                )
              ) : data.tasks.length ? (
              <ul className="divide-y divide-slate-100">
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
                <Empty>暂无待办。智能体分析产生的行动项会出现在这里</Empty>
              )}
            </div>
          </Card>
        </Section>
      </div>

      <SignalDrawer signalId={signalId} onClose={() => setSignalId(null)} />
    </div>
  );
}
