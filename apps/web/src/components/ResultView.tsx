import type { AgentResult } from '@agentos/shared';
import { CheckCircle2, CircleHelp, Lightbulb, ListTodo } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DataTable } from './DataTable.tsx';

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
