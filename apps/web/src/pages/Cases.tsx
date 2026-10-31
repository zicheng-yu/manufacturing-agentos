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
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
          <Handshake className="size-5 text-brand-600" />
          协作事项
        </h1>
        <p className="text-sm text-slate-500">同一件业务事，多个岗位接力：证据持续更新，做过了与验证有效分开记录。从驾驶舱的信号或数据发现里点「发起协作」创建。</p>
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
            <Empty>还没有协作事项</Empty>
          )}
        </Card>
      )}
    </div>
  );
}

export type { CaseDetail };
