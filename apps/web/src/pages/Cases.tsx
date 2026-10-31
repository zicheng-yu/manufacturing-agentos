import { CASE_STATUS_LABELS, CASE_STATUSES, DOMAIN_LABELS, OBJECT_TYPE_LABELS, type CaseDetail, type CaseStatus, type CaseSummary } from '@agentos/shared';
import { Handshake } from 'lucide-react';
import { Link } from 'react-router';
import { useApi } from '../api.ts';
import { Card, cx, DomainTag, Empty, Spinner, timeAgo } from '../ui.tsx';

export const STATUS_STYLE: Record<CaseStatus, string> = {
  pending: 'bg-slate-100 text-slate-700',
  active: 'bg-brand-50 text-brand-700',
  verifying: 'bg-watch text-watch-ink',
  verified: 'bg-green-100 text-green-900',
};

const STATUS_HINT: Record<CaseStatus, string> = {
  pending: '刚发起，还没有确认处置',
  active: '处置执行中，回执只说明做过了',
  verifying: '处置完成，等待验证是否真的有效',
  verified: '有判据、有证据，才算解决',
};

export function StatusPill({ status }: { status: CaseStatus }) {
  return <span className={cx('inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs font-semibold', STATUS_STYLE[status])}>{CASE_STATUS_LABELS[status]}</span>;
}

/** The four states as a path, so "done" and "verified" are visibly different steps. */
export function StatusPath({ status, round }: { status: CaseStatus; round: number }) {
  const at = CASE_STATUSES.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="事项进展">
      {CASE_STATUSES.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={cx('rounded px-2 py-1', i === at ? STATUS_STYLE[s] + ' font-semibold' : i < at ? 'bg-slate-100 text-slate-700' : 'text-slate-400')}>
            {i < at ? '✓ ' : ''}
            {CASE_STATUS_LABELS[s]}
          </span>
          {i < CASE_STATUSES.length - 1 && <span className="text-slate-300">→</span>}
        </li>
      ))}
      {round > 1 && <li className="ml-1 rounded bg-slate-100 px-2 py-1 text-slate-600">第 {round} 轮处置</li>}
    </ol>
  );
}

export function ObjectChips({ objects }: { objects: CaseSummary['objects'] }) {
  if (!objects.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {objects.map((o) => (
        <li key={`${o.type}:${o.id}`} className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700" title={o.domains.map((d) => DOMAIN_LABELS[d]).join('、')}>
          <span className="text-slate-500">{OBJECT_TYPE_LABELS[o.type]}</span> <span className="font-mono">{o.id}</span>
          {o.label && o.label !== o.id ? <span className="text-slate-500">（{o.label}）</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function CaseList() {
  const { data, error } = useApi<CaseSummary[]>('/api/cases');
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <div className="space-y-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
            <Handshake className="size-5 text-brand-600" />
            协作事项
          </h1>
          <p className="mt-1 text-sm text-slate-500">同一件业务事，多个岗位接力：证据持续更新，做过了与验证有效分开记录。</p>
        </div>
        <ol className="grid gap-2 sm:grid-cols-4" aria-label="事项生命周期">
          {CASE_STATUSES.map((s, i) => (
            <li key={s} className={cx('rounded-lg border px-3 py-2 text-xs', STATUS_STYLE[s], 'border-transparent')}>
              <span className="num mr-1.5 text-base font-bold">{String(i + 1).padStart(2, '0')}</span>
              <span className="font-semibold">{CASE_STATUS_LABELS[s]}</span>
              <span className="mt-0.5 block opacity-80">{STATUS_HINT[s]}</span>
            </li>
          ))}
        </ol>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!data && !error ? (
        <div className="flex justify-center p-8 text-slate-400"><Spinner /></div>
      ) : (
        <Card>
          {data?.length ? (
            <ul className="divide-y divide-slate-100">
              {data.map((c) => (
                <li key={c.id}>
                  <Link to={`/cases/${c.id}`} className="block px-4 py-3 hover:bg-slate-50">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={c.status} />
                      {c.needsReview && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">需复核</span>}
                      <span className="font-mono text-xs text-slate-500">{c.id}</span>
                      {c.domains.map((d) => <DomainTag key={d} domain={d} />)}
                      <span className="ml-auto text-xs text-slate-500">{timeAgo(c.updatedAt)}</span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">{c.goal}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>负责人：{c.owner.name}</span>
                      {c.round > 1 && <span>第 {c.round} 轮</span>}
                      <ObjectChips objects={c.objects} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3 px-4 py-8 text-center">
              <p className="text-sm font-medium text-slate-700">还没有协作事项</p>
              <p className="mx-auto max-w-md text-sm text-slate-500">在驾驶舱点开一条信号，或在数据发现助手的卡片上点「发起协作」，就会在这里生成一个持久的事项。</p>
              <Link to="/" className="inline-block rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100">去驾驶舱选一条信号</Link>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

export type { CaseDetail };
