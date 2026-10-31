import type { AgentResult } from '@agentos/shared';
import { CheckCircle2, CircleHelp, Lightbulb, ListTodo } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DataTable } from './DataTable.tsx';
import { Link } from 'react-router';
import type { Turn } from '@agentos/shared';

export function DiscoveryCards({ turn }: { turn: Turn }) {
  if (!turn.result.discoveries?.length) return null;
  return <div className="grid gap-3 lg:grid-cols-2" aria-label="可追溯数据发现">
    {turn.result.discoveries.map(d => <section key={d.id} className="rounded-lg border border-slate-200 p-4">
      <div className="mb-2 text-xs font-medium text-brand-700">{d.kind}</div>
      <h4 className="font-semibold text-slate-900">{d.title}</h4>
      <p className="mt-2 text-sm leading-relaxed">{d.summary}</p>
      <p className="mt-2 text-xs text-slate-500">{d.source} · {d.scope}</p>
      <p className="mt-2 text-xs text-amber-800">{d.limitation}</p>
      <details className="my-3 text-sm"><summary className="cursor-pointer text-brand-700">查看计算证据</summary><div className="mt-2 overflow-x-auto"><DataTable table={d.evidence} /></div></details>
      <Link className="text-sm font-medium text-brand-700 hover:underline" to={`/agents/${d.agentId}?${new URLSearchParams({ q: d.question, sourceTurnId: turn.id, sourceFindingId: d.id })}`}>交给领域助手继续分析 →</Link>
    </section>)}
  </div>;
}

export function ReferenceSource({ result }: { result: AgentResult }) {
  const r = result.reference;
  if (!r) return null;
  return <details className="rounded-lg border border-brand-200 bg-brand-50/40 p-3 text-sm">
    <summary className="cursor-pointer text-brand-800">接续来源：{r.agentId} · {r.refreshedAt ? '本轮已重新计算' : '历史计算快照'}</summary>
    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{r.summary}</p>
    <p className="mt-2 text-xs text-slate-500">原分析 {new Date(r.createdAt).toLocaleString('zh-CN')}{r.refreshedAt ? `；重算 ${new Date(r.refreshedAt).toLocaleString('zh-CN')}` : '；当前业务数据优先'}</p>
    <Link className="mt-2 inline-block text-xs text-brand-700 hover:underline" to={`/agents/${r.agentId}/${r.conversationId}`}>返回来源对话</Link>
  </details>;
}

const GROUP_STYLE = {
  fact: { box: 'border-slate-200 bg-slate-50', label: 'text-brand-700' },
  pending: { box: 'border-[#f5d27a] bg-[#fff8e6]', label: 'text-watch-ink' },
  advice: { box: 'border-green-200 bg-green-50', label: 'text-green-900' },
};

function Group({ title, en, items, icon: Icon, tone }: { title: string; en: string; items: string[]; icon: typeof CheckCircle2; tone: keyof typeof GROUP_STYLE }) {
  if (items.length === 0) return null;
  const style = GROUP_STYLE[tone];
  return (
    <div className={`rounded-[10px] border p-3.5 ${style.box}`}>
      <div className={`mb-2 flex items-center gap-1.5 font-mono text-[11px] tracking-[0.12em] ${style.label}`}>
        <Icon className="size-3.5" />
        {title} · {en}
      </div>
      <ul className="space-y-1.5 text-[13px] text-slate-800">
        {items.map((item) => (
          <li key={item} className="leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * CommonMark does not close `**` after full-width punctuation when a Chinese character follows ("**结论。**其后"),
 * so the asterisks show. Moving the punctuation outside the emphasis keeps the meaning and renders as bold.
 */
export function fixCjkEmphasis(markdown: string): string {
  return markdown.replace(/\*\*([^*\n]+?)([。，；：！？、）」』”])\*\*/g, '**$1**$2');
}

export function Answer({ markdown }: { markdown: string }) {
  return (
    <div className="markdown text-sm leading-relaxed text-slate-700">
      <Markdown remarkPlugins={[remarkGfm]}>{fixCjkEmphasis(markdown)}</Markdown>
    </div>
  );
}

export function PolicySources({ result }: { result: AgentResult }) {
  if (!result.policy?.citations.length) return null;
  return <div className="space-y-2" aria-label="引用的公司制度">
    {result.policy.citations.map((source) => <details key={source.sourceId + source.quote} className="rounded-lg border border-brand-100 bg-brand-50/40 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-brand-800">{source.title} · v{source.version} · 条款 {source.section}</summary>
      <p className="mt-2 text-xs text-slate-500">{source.documentId} · {source.kind === 'faq' ? 'HR 已审核 FAQ' : '公司制度'} · {source.scope} · 生效：{source.effectiveFrom ?? '历史演示制度未标注'}</p>
      <blockquote className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{source.quote}</blockquote>
    </details>)}
  </div>;
}

/** Facts, pending checks and suggestions kept apart, so nobody mistakes a suggestion for a fact. */
export function Evidence({ result }: { result: AgentResult }) {
  if (!result.facts.length && !result.pending.length && !result.suggestions.length) return null;
  return (
    <div className="@container">
      <div className="grid gap-3 @2xl:grid-cols-3">
        <Group title="事实" en="FACT" items={result.facts} icon={CheckCircle2} tone="fact" />
        <Group title="待核" en="PENDING" items={result.pending} icon={CircleHelp} tone="pending" />
        <Group title="建议" en="ADVICE" items={result.suggestions} icon={Lightbulb} tone="advice" />
      </div>
    </div>
  );
}

export function Actions({ result }: { result: AgentResult }) {
  if (result.actions.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 text-[13px] font-bold text-slate-900">
        <ListTodo className="size-3.5" />
        行动项（已写入待办）
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-[13px]">
        {result.actions.map((a) => (
          <li key={a.title} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
            <span className="flex-1 text-slate-700">{a.title}</span>
            {a.owner && <span className="text-xs text-slate-500">{a.owner}</span>}
            {a.due && <span className="font-mono text-xs text-slate-500">{a.due}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Artifacts({ result, compact }: { result: AgentResult; compact?: boolean }) {
  if (result.artifacts.length === 0) return null;
  return (
    <div className="space-y-3">
      {result.artifacts.map((artifact) => (
        <div key={artifact.title} className="overflow-hidden rounded-[10px] border border-slate-200">
          <div className="bg-ink-900 px-3.5 py-2.5 font-mono text-xs tracking-[0.04em] text-white">{artifact.title}</div>
          <DataTable table={artifact} compact={compact} />
        </div>
      ))}
    </div>
  );
}
