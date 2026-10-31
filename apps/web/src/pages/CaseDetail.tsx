import { DOMAIN_LABELS, type ActionItem, type CaseDetail as Detail, type CaseEntry, type Domain } from '@agentos/shared';
import { ArrowLeft, CheckCircle2, CircleHelp, Lightbulb, Plus, Send, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api.ts';
import { DataTable } from '../components/DataTable.tsx';
import { Answer } from '../components/ResultView.tsx';
import { useLive, useSession } from '../session.tsx';
import { Card, cx, DomainTag, Empty, formatTime, scopeLabel, SeverityBadge, Spinner } from '../ui.tsx';
import { ObjectChips, StatusPath, StatusPill } from './Cases.tsx';

const FIELD = 'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800';
const BUTTON = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const GHOST = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50';

const KIND_LABEL: Record<CaseEntry['kind'], string> = { evidence: '证据', analysis: '分析', action: '处置', receipt: '回执', verification: '验证', reference: '引用经验' };
const KIND_STYLE: Record<CaseEntry['kind'], string> = {
  evidence: 'bg-slate-100 text-slate-700',
  analysis: 'bg-brand-50 text-brand-700',
  action: 'bg-amber-100 text-amber-900',
  receipt: 'bg-green-100 text-green-900',
  verification: 'bg-ink-900 text-white',
  reference: 'bg-purple-100 text-purple-900',
};

function Part({ no, title, en, children, action }: { no: string; title: string; en: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="num text-xl leading-none font-bold text-brand-600">{no}</span>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        <span className="hidden font-mono text-[11px] tracking-[0.14em] text-slate-500 sm:inline">{en}</span>
        <span className="h-px flex-1 bg-slate-300" />
        {action}
      </div>
      {children}
    </section>
  );
}

function Lines({ icon: Icon, label, items, tone }: { icon: typeof CheckCircle2; label: string; items: string[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div className={cx('rounded-lg border p-2.5', tone)}>
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold"><Icon className="size-3.5" />{label}</div>
      <ul className="space-y-1 text-[13px] text-slate-800">{items.map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  );
}

function EntryCard({ entry, children }: { entry: CaseEntry; children?: ReactNode }) {
  const events = (entry.data.events as { id: string; severity: 'info' | 'warn' | 'critical'; title: string; summary: string; typeLabel: string }[] | undefined) ?? [];
  const simulated = entry.data.simulated === true;
  return (
    <li className="space-y-2 rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cx('rounded px-2 py-0.5 font-semibold', KIND_STYLE[entry.kind])}>{KIND_LABEL[entry.kind]}</span>
        {entry.domain !== 'executive' && <DomainTag domain={entry.domain as Domain} />}
        <span className="text-slate-600">{entry.author.name}{entry.author.title ? `（${entry.author.title}）` : ''}</span>
        {entry.round > 1 && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">第 {entry.round} 轮</span>}
        {simulated && <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900">模拟回执</span>}
        <span className="ml-auto text-slate-400">{formatTime(entry.createdAt)}</span>
      </div>
      <h3 className="text-sm font-semibold text-slate-900">{entry.title}</h3>
      {entry.kind === 'analysis' ? <Answer markdown={entry.body} /> : entry.body && <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-700">{entry.body}</p>}
      {Array.isArray(entry.data.basis) && (
        <p className="text-xs text-amber-900">关联依据：{(entry.data.basis as string[]).join('；')}（共同实体或标签只是线索，不代表已验证的因果）</p>
      )}
      {events.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex gap-2 px-2.5 py-1.5">
              <SeverityBadge severity={e.severity} />
              <span><span className="font-medium text-slate-800">{e.title}</span> <span className="text-slate-500">{e.summary}</span></span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 md:grid-cols-3">
        <Lines icon={CheckCircle2} label="事实" items={entry.facts} tone="border-slate-200 bg-slate-50" />
        <Lines icon={CircleHelp} label="待核" items={entry.pending} tone="border-[#f5d27a] bg-[#fff8e6]" />
        <Lines icon={Lightbulb} label="建议" items={entry.suggestions} tone="border-green-200 bg-green-50" />
      </div>
      {entry.artifacts.map((t) => (
        <div key={t.title} className="overflow-hidden rounded-lg border border-slate-200">
          <div className="bg-ink-900 px-3 py-1.5 font-mono text-xs text-white">{t.title}</div>
          <DataTable table={t} compact />
        </div>
      ))}
      {children}
    </li>
  );
}

export function CaseDetailPage() {
  const { caseId } = useParams();
  const { session } = useSession();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      setDetail(await api<Detail>(`/api/cases/${caseId}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? '事项不存在，或当前账号无权查看' : (e as Error).message);
    }
  }
  useEffect(() => {
    setDetail(null);
    void load();
  }, [caseId]);
  // New signals and events change a case's candidates and evidence; reload quietly when something relevant moves.
  useLive((m) => { if (detail && (m.kind === 'signal.raised' || m.kind === 'signal.updated' || m.kind === 'signal.cleared')) void load(); });

  async function act(key: string, path: string, body: unknown = {}) {
    setBusy(key);
    setNotice(null);
    try {
      setDetail(await api<Detail>(`/api/cases/${caseId}/${path}`, { method: 'POST', body }));
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="mx-auto max-w-3xl space-y-3 p-6"><p role="alert" className="text-sm text-red-600">{error}</p><Link to="/cases" className="text-sm text-brand-700 hover:underline">返回协作事项</Link></div>;
  if (!detail) return <div className="flex justify-center p-12 text-slate-400"><Spinner /></div>;

  const { summary: s } = detail;
  const evidence = detail.entries.filter((e) => e.kind === 'evidence' || e.kind === 'reference');
  const work = detail.entries.filter((e) => ['analysis', 'action', 'receipt'].includes(e.kind));
  const checks = detail.entries.filter((e) => e.kind === 'verification');
  const locked = s.status === 'verified';

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <Link to="/cases" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-brand-700"><ArrowLeft className="size-4" />协作事项</Link>

      <header className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={s.status} />
          {s.needsReview && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">需复核：验证之后又出现了新证据</span>}
          <span className="font-mono text-xs text-slate-500">{s.id}</span>
          {s.domains.map((d) => <DomainTag key={d} domain={d} />)}
        </div>
        <h1 className="text-lg font-bold text-slate-900">{s.goal}</h1>
        <StatusPath status={s.status} round={s.round} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
          <span>负责人：{s.owner.name}（{s.owner.title}）</span>
          <span>你的身份：{session?.account.displayName}{detail.canManage ? '（可管理本事项）' : '（可参与分析与回执）'}</span>
        </div>
        <ObjectChips objects={s.objects} />
        {detail.hiddenEntries > 0 && <p className="text-xs text-slate-500">另有 {detail.hiddenEntries} 条记录属于你无权查看的部门，已隐藏；事项摘要和助手背景也不包含这些内容。</p>}
        {s.needsReview && detail.canManage && <button className={GHOST} disabled={!!busy} onClick={() => void act('reopen', 'reopen')}>重新开启处置（保留之前的全部记录）</button>}
      </header>

      {notice && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{notice}</p>}

      <Part no="01" title="关联证据" en="EVIDENCE">
        <ul className="space-y-2.5">{evidence.map((e) => <EntryCard key={e.id} entry={e} />)}</ul>
        {detail.candidates.length > 0 && (
          <Card title={<span className="text-sm">其他部门可能相关的信号（线索，不是结论）</span>}>
            <ul className="divide-y divide-slate-100">
              {detail.candidates.map((c) => (
                <li key={c.signalId} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <SeverityBadge severity={c.severity} />
                  <DomainTag domain={c.domain} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800">{c.title}</div>
                    <div className="text-xs text-amber-900">关联依据：{c.basis.join('；')}</div>
                  </div>
                  {c.added ? <span className="text-xs text-green-800">已加入</span> : !locked && (
                    <button className={GHOST} disabled={!!busy} onClick={() => void act(`cand-${c.signalId}`, 'candidates', { signalId: c.signalId })}><Plus className="size-4" />加入事项</button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {detail.live.length > 0 && (
          <Card title={<span className="text-sm">按当前业务数据重新计算</span>}>
            <ul className="divide-y divide-slate-100 text-sm">
              {detail.live.map((r) => (
                <li key={r.label} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <span className={cx('rounded px-2 py-0.5 text-xs font-semibold', r.ok ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-800')}>{r.ok ? '已恢复' : '仍有风险'}</span>
                  <span className="font-medium text-slate-800">{r.label}</span>
                  <span className="text-slate-600">{r.value}</span>
                  <span className="ml-auto text-xs text-slate-400">{r.source}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Part>

      <Part no="02" title="岗位行动" en="ROLES">
        {!locked && <AskPanel detail={detail} busy={busy} onAsk={(agentId, question) => act('ask', 'ask', { agentId, question })} />}
        <ul className="space-y-2.5">
          {work.map((e) => (
            <EntryCard key={e.id} entry={e}>
              {e.kind === 'analysis' && detail.canManage && !locked && s.status !== 'verifying' && Array.isArray(e.data.actions) && (e.data.actions as ActionItem[]).length > 0 && (
                <div className="space-y-1.5 border-t border-slate-100 pt-2">
                  <div className="text-xs font-semibold text-slate-700">助手给出的行动项（确认后成为本事项的处置并跟踪）</div>
                  {(e.data.actions as ActionItem[]).map((a, i) => {
                    const taken = detail.entries.some((x) => x.kind === 'action' && x.round === s.round && x.data.fromEntryId === e.id && x.title === a.title);
                    return (
                      <div key={a.title} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1">{a.title}<span className="ml-2 text-xs text-slate-500">{a.owner} {a.due}</span></span>
                        {taken ? <span className="text-xs text-green-800">已确认</span> : <button className={GHOST} disabled={!!busy} onClick={() => void act(`act-${e.id}-${i}`, 'actions', { fromEntryId: e.id, actionIndex: i })}>确认为处置</button>}
                      </div>
                    );
                  })}
                </div>
              )}
              {e.kind === 'action' && !detail.entries.some((x) => x.kind === 'receipt' && x.data.actionEntryId === e.id) && !locked && (
                <ReceiptForm busy={!!busy} onSubmit={(note, simulated) => act(`rec-${e.id}`, 'receipts', { actionEntryId: e.id, note, simulated })} />
              )}
            </EntryCard>
          ))}
          {!work.length && <Empty>还没有岗位参与。选择一个助手开始分析，或由负责人直接登记处置。</Empty>}
        </ul>
        {detail.canManage && !locked && s.status !== 'verifying' && <ManualAction onSubmit={(body) => act('manual-action', 'actions', body)} busy={!!busy} />}
        {detail.tasks.length > 0 && (
          <Card title={<span className="text-sm">本事项的待办</span>}>
            <ul className="divide-y divide-slate-100 text-sm">
              {detail.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <span className={cx('rounded px-1.5 py-0.5 text-xs font-semibold', t.status === 'done' ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900')}>{t.status === 'done' ? '已执行' : '待执行'}</span>
                  <span className="min-w-0 flex-1 text-slate-800">{t.title}</span>
                  <span className="text-xs text-slate-500">{t.owner} {t.due}</span>
                </li>
              ))}
            </ul>
            <p className="px-4 pb-3 text-xs text-slate-500">「已执行」只表示这条待办处理了，不代表问题已经消失；是否有效由下面的验证记录说明。</p>
          </Card>
        )}
      </Part>

      <Part no="03" title="验证记录" en="VERIFICATION">
        <ul className="space-y-2.5">{checks.map((e) => <EntryCard key={e.id} entry={e}>
          <p className="text-xs text-slate-600">判据：{String(e.data.criterion)}；确认人：{String(e.data.confirmer)}；观察时间：{formatTime(String(e.data.at))}；方式：{e.data.mode === 'auto' ? '系统按业务数据重算' : '人工核验（非系统自动证实）'}</p>
        </EntryCard>)}</ul>
        {!checks.length && s.status !== 'verifying' && <Empty>还没有验证记录。处置完成并提交验证后，这里会记录判据、观察时间和确认人。</Empty>}
        {detail.canManage && s.status === 'active' && (
          <div className="flex flex-wrap items-center gap-2">
            <button className={BUTTON} disabled={!!busy} onClick={() => void act('submit', 'submit')}><Send className="size-4" />处置已完成，提交验证</button>
            <span className="text-xs text-slate-500">每项处置都需要回执；提交后进入「待验证」，此时才可判断是否真正解决。</span>
          </div>
        )}
        {detail.canManage && s.status === 'verifying' && <VerifyPanel canAuto={detail.canAutoVerify} busy={!!busy} onVerify={(body) => act('verify', 'verify', body)} />}
        {locked && detail.canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button className={GHOST} disabled={!!busy} onClick={() => void act('reopen', 'reopen')}>重新开启处置</button>
          </div>
        )}
        {locked && <LessonPanel detail={detail} busy={!!busy} onSave={(body) => act('lesson', 'lesson', body)} />}
        {detail.similarLessons.length > 0 && !locked && (
          <Card title={<span className="flex items-center gap-1.5 text-sm"><ShieldCheck className="size-4 text-purple-700" />类似事项的已验证经验（供参考）</span>}>
            <ul className="divide-y divide-slate-100">
              {detail.similarLessons.map((l) => {
                const used = detail.entries.some((e) => e.kind === 'reference' && e.data.lessonId === l.id);
                return (
                  <li key={l.id} className="space-y-1 px-4 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-900">{l.title}</span><DomainTag domain={l.domain} /><span className={cx('rounded px-1.5 py-0.5 text-xs font-semibold', l.conclusion === 'effective' ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-800')}>{l.conclusion === 'effective' ? '历史结论：有效' : '历史结论：无效'}</span></div>
                    <p className="text-xs text-slate-600">适用条件：{l.conditions}</p>
                    <p className="text-xs text-slate-600">措施：{l.measure}</p>
                    <p className="text-xs text-slate-500">来源事项 {l.sourceCaseId}；{l.result}；确认：{l.confirmedBy}，{formatTime(l.confirmedAt)}</p>
                    {used ? <span className="text-xs text-green-800">已引用</span> : <button className={GHOST} disabled={!!busy} onClick={() => void act(`ref-${l.id}`, 'references', { lessonId: l.id })}>引用为参考</button>}
                    <p className="text-[11px] text-amber-900">经验只是参考，是否适用需对照本次证据核查，不能替代本次验证。</p>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </Part>
    </div>
  );
}

function AskPanel({ detail, busy, onAsk }: { detail: Detail; busy: string | null; onAsk: (agentId: string, question: string) => Promise<boolean> }) {
  const [agentId, setAgentId] = useState(detail.agents[0]?.id ?? '');
  const [question, setQuestion] = useState('');
  const agent = detail.agents.find((a) => a.id === agentId);
  if (!detail.agents.length) return null;
  return (
    <Card title={<span className="text-sm">请一位助手接力分析（带上本事项里你有权查看的内容）</span>}>
      <form
        className="space-y-2.5 p-4"
        onSubmit={(e) => { e.preventDefault(); void onAsk(agentId, question).then((ok) => ok && setQuestion('')); }}
      >
        <div className="flex flex-wrap gap-2">
          <select aria-label="选择助手" className={cx(FIELD, 'sm:max-w-xs')} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {detail.agents.map((a) => <option key={a.id} value={a.id}>{scopeLabel(a.domain)} · {a.name}</option>)}
          </select>
          <input aria-label="向助手提问" className={cx(FIELD, 'flex-1')} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如：线束快断货了，几家供应商怎么选？" maxLength={2000} />
          <button className={BUTTON} disabled={!!busy || !question.trim()}>{busy === 'ask' ? <Spinner className="size-3.5" /> : <Send className="size-4" />}提问</button>
        </div>
        {agent && (
          <div className="flex flex-wrap gap-1.5">
            {agent.starters.map((q) => <button key={q} type="button" className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 hover:border-brand-300 hover:text-brand-700" onClick={() => setQuestion(q)}>{q}</button>)}
          </div>
        )}
        {busy === 'ask' && <p className="text-xs text-slate-500">助手正在读取当前业务数据与事项背景，结果会回到本事项…</p>}
      </form>
    </Card>
  );
}

function ReceiptForm({ busy, onSubmit }: { busy: boolean; onSubmit: (note: string, simulated: boolean) => Promise<boolean> }) {
  const [note, setNote] = useState('');
  const [simulated, setSimulated] = useState(true);
  return (
    <form className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2" onSubmit={(e) => { e.preventDefault(); void onSubmit(note, simulated).then((ok) => ok && setNote('')); }}>
      <input aria-label="执行回执" className={cx(FIELD, 'flex-1')} value={note} onChange={(e) => setNote(e.target.value)} placeholder="执行回执：做了什么、结果如何" maxLength={500} />
      <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} />演示用模拟回执</label>
      <button className={GHOST} disabled={busy || note.trim().length < 2}>提交回执</button>
    </form>
  );
}

function ManualAction({ onSubmit, busy }: { onSubmit: (body: unknown) => Promise<boolean>; busy: boolean }) {
  const { session } = useSession();
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState<Domain>(session!.domains[0]);
  return (
    <form className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-3" onSubmit={(e) => { e.preventDefault(); void onSubmit({ title, domain }).then((ok) => ok && setTitle('')); }}>
      <span className="text-xs font-semibold text-slate-700">直接登记处置</span>
      <select aria-label="责任部门" className={cx(FIELD, 'sm:w-36')} value={domain} onChange={(e) => setDomain(e.target.value as Domain)}>{session!.domains.map((d) => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}</select>
      <input aria-label="处置内容" className={cx(FIELD, 'flex-1')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：启用备选供应商并加急现有订单" maxLength={200} />
      <button className={GHOST} disabled={busy || title.trim().length < 2}><Plus className="size-4" />登记</button>
    </form>
  );
}

function VerifyPanel({ canAuto, busy, onVerify }: { canAuto: boolean; busy: boolean; onVerify: (body: unknown) => Promise<boolean> }) {
  const [criterion, setCriterion] = useState('');
  const [note, setNote] = useState('');
  return (
    <Card title={<span className="text-sm">验证：处置做完了，问题真的消失了吗？</span>}>
      <div className="space-y-3 p-4">
        {canAuto && (
          <div className="space-y-1.5">
            <p className="text-sm text-slate-700">系统按当前库存、在途订单和日耗重新计算涉及物料的状态；结果不会被回执影响。</p>
            <button className={BUTTON} disabled={busy} onClick={() => void onVerify({ mode: 'auto' })}>按业务数据重新验证</button>
          </div>
        )}
        <form className="space-y-2" onSubmit={(e) => e.preventDefault()}>
          <p className="text-sm font-medium text-slate-800">人工核验{canAuto ? '（系统无法重算时使用）' : ''}</p>
          <input aria-label="验证判据" className={FIELD} value={criterion} onChange={(e) => setCriterion(e.target.value)} placeholder="判据：什么情况算解决，例如「线束03 库存回到安全库存以上」" maxLength={300} />
          <input aria-label="证据来源" className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} placeholder="观察到什么、证据来自哪里，例如「仓库盘点单显示在库 3000 件」" maxLength={500} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={busy || criterion.trim().length < 4 || note.trim().length < 4} onClick={() => void onVerify({ mode: 'manual', passed: true, criterion, note })}>人工核验：通过</button>
            <button type="button" className={GHOST} disabled={busy || criterion.trim().length < 4 || note.trim().length < 4} onClick={() => void onVerify({ mode: 'manual', passed: false, criterion, note })}>人工核验：未通过，回到处理中</button>
          </div>
          <p className="text-xs text-slate-500">人工核验会在记录中标明「非系统自动证实」，并保存判据、证据来源和确认人。</p>
        </form>
      </div>
    </Card>
  );
}

function LessonPanel({ detail, busy, onSave }: { detail: Detail; busy: boolean; onSave: (body: unknown) => Promise<boolean> }) {
  const [conditions, setConditions] = useState('');
  const [conclusion, setConclusion] = useState<'effective' | 'ineffective'>('effective');
  const lesson = detail.lesson;
  if (lesson) {
    return (
      <Card title={<span className="flex items-center gap-1.5 text-sm"><ShieldCheck className="size-4 text-purple-700" />已沉淀的经验卡</span>}>
        <dl className="space-y-1.5 p-4 text-sm text-slate-700">
          <div><dt className="inline font-semibold">对象/症状：</dt><dd className="inline">{lesson.symptom}</dd></div>
          <div><dt className="inline font-semibold">适用条件：</dt><dd className="inline">{lesson.conditions}</dd></div>
          <div><dt className="inline font-semibold">措施：</dt><dd className="inline">{lesson.measure}</dd></div>
          <div><dt className="inline font-semibold">验证结果：</dt><dd className="inline">{lesson.result}（{lesson.conclusion === 'effective' ? '有效' : '无效'}）</dd></div>
          <div className="text-xs text-slate-500">来源事项 {lesson.sourceCaseId}；确认：{lesson.confirmedBy}，{formatTime(lesson.confirmedAt)}</div>
        </dl>
      </Card>
    );
  }
  if (!detail.canManage) return null;
  return (
    <Card title={<span className="text-sm">沉淀为经验卡（由你确认后保存，不会自动保存）</span>}>
      <form className="space-y-2 p-4" onSubmit={(e) => { e.preventDefault(); void onSave({ conditions, conclusion }); }}>
        <input aria-label="适用条件" className={FIELD} value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="适用条件：什么情况下这个做法才成立，例如「日耗稳定、备选供应商已完成来料验证」" maxLength={500} />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5"><input type="radio" name="conclusion" checked={conclusion === 'effective'} onChange={() => setConclusion('effective')} />有效</label>
          <label className="flex items-center gap-1.5"><input type="radio" name="conclusion" checked={conclusion === 'ineffective'} onChange={() => setConclusion('ineffective')} />无效</label>
          <button className={BUTTON} disabled={busy || conditions.trim().length < 4}>保存经验卡</button>
        </div>
        <p className="text-xs text-slate-500">经验卡会记录措施、验证结果、来源事项和确认人。</p>
      </form>
    </Card>
  );
}
