import type { AgentResult } from '@agentos/shared';
import { CheckCircle2, CircleHelp, Lightbulb, ListTodo } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DataTable } from './DataTable.tsx';

function Group({ title, items, icon: Icon, className }: { title: string; items: string[]; icon: typeof CheckCircle2; className: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`mb-1 flex items-center gap-1 text-xs font-medium ${className}`}>
        <Icon className="size-3.5" />
        {title}
      </div>
      <ul className="space-y-1 text-[13px] text-slate-600">
        {items.map((item) => (
          <li key={item} className="leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Answer({ markdown }: { markdown: string }) {
  return (
    <div className="markdown text-sm leading-relaxed text-slate-700">
      <Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>
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
    <div className="@container rounded-lg bg-slate-50 p-3">
      <div className="grid gap-3 @2xl:grid-cols-3">
      <Group title="事实" items={result.facts} icon={CheckCircle2} className="text-brand-600" />
      <Group title="待核" items={result.pending} icon={CircleHelp} className="text-amber-700" />
      <Group title="建议" items={result.suggestions} icon={Lightbulb} className="text-emerald-700" />
      </div>
    </div>
  );
}

export function Actions({ result }: { result: AgentResult }) {
  if (result.actions.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-slate-700">
        <ListTodo className="size-3.5" />
        行动项（已写入待办）
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-[13px]">
        {result.actions.map((a) => (
          <li key={a.title} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
            <span className="flex-1 text-slate-700">{a.title}</span>
            {a.owner && <span className="text-xs text-slate-500">{a.owner}</span>}
            {a.due && <span className="text-xs text-slate-400">{a.due}</span>}
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
        <div key={artifact.title} className="overflow-hidden rounded-lg border border-slate-200">
          <div className="border-b border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700">{artifact.title}</div>
          <DataTable table={artifact} compact={compact} />
        </div>
      ))}
    </div>
  );
}
