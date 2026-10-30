import type { Turn } from '@agentos/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../../api.ts';
import { Actions, Answer, Artifacts, Evidence } from '../../components/ResultView.tsx';
import { useLive } from '../../session.tsx';
import { Card, cx, Empty, Spinner } from '../../ui.tsx';
import { KnowledgeEditor, KnowledgeManager } from './KnowledgeManager.tsx';

interface ServiceRequest {
  id: string;
  question: string;
  category: string;
  status: '待处理' | '处理中' | '已解决';
  createdAt: string;
  answer: string;
  handledBy: string | null;
  history: string[];
}

interface RoleProfile {
  positionId: string;
  position: { title: string; department: string; status: string };
  skills: { name: string; level: number }[];
}

const FIELD = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';
const BUTTON = 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-wait disabled:opacity-50';
const LEVELS = ['0 · 未掌握', '1 · 了解', '2 · 可独立完成', '3 · 可指导他人'];
const MODES = [{ id: 'service', label: '员工服务' }, { id: 'knowledge', label: '制度知识库' }, { id: 'recruitment', label: '招聘初筛' }, { id: 'training', label: '岗位培训' }] as const;
type Mode = typeof MODES[number]['id'];

export function HrWorkbench({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState<Mode>('service');
  const [busy, setBusy] = useState(false);
  const [knowledgeId, setKnowledgeId] = useState('');
  return (
    <Card title="HR 工作台">
      <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3" aria-label="HR 工作流程">
        {MODES.map((item) => (
          <button key={item.id} type="button" aria-pressed={mode === item.id} disabled={busy} onClick={() => setMode(item.id)}
            className={cx('rounded-lg px-4 py-2 text-sm disabled:opacity-50', mode === item.id ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-50')}>
            {item.label}
          </button>
        ))}
      </div>
      {mode === 'service'
        ? <ServiceQueue onChanged={onChanged} onBusy={setBusy} onDraft={(id) => { setKnowledgeId(id); setMode('knowledge'); }} />
        : mode === 'knowledge' ? <KnowledgeManager selectedId={knowledgeId} onBusy={setBusy} onChanged={onChanged} />
        : <TalentWorkbench key={mode} mode={mode} onBusy={setBusy} />}
    </Card>
  );
}

function ServiceQueue({ onChanged, onBusy, onDraft }: { onChanged: () => void; onBusy: (busy: boolean) => void; onDraft: (id: string) => void }) {
  const requests = useApi<ServiceRequest[]>('/api/modules/hr/requests');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const selected = requests.data?.find((r) => r.id === selectedId);
  useLive((message) => {
    if ('event' in message && message.event.domain === 'hr') void requests.reload();
  });
  const visible = requests.data?.filter((r) => showResolved || r.status !== '已解决') ?? [];
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-slate-500">制度未覆盖的问题会自动进入队列，处理后保留答复记录。</p>
        <Link to="/employee-service" className="font-medium text-brand-700 hover:underline">打开公司制度助手 →</Link>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={showResolved} disabled={busy} onChange={(e) => setShowResolved(e.target.checked)} />
        显示已解决请求
      </label>
      {requests.error ? <p role="alert" className="text-sm text-red-700">{requests.error} <button type="button" onClick={() => void requests.reload()} className="underline">重试</button></p> : null}
      {!requests.data && requests.loading ? <Spinner /> : null}
      {requests.data && visible.length === 0 ? <Empty>暂无待处理请求</Empty> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <ul className="max-h-96 space-y-2 overflow-y-auto">
          {visible.map((request) => (
            <li key={request.id}>
              <button type="button" disabled={busy} onClick={() => { setSelectedId(request.id); setNotice(''); }}
                className={cx('w-full rounded-lg border p-3 text-left hover:border-brand-300 disabled:opacity-50', selectedId === request.id ? 'border-brand-400 bg-brand-50' : 'border-slate-200')}>
                <span className="flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{request.category} · {request.createdAt}</span><span>{request.status}</span></span>
                <span className="mt-2 block text-sm font-medium text-slate-800">{request.question}</span>
                <span className="mt-1 block text-xs text-slate-400">{request.id}</span>
              </button>
            </li>
          ))}
        </ul>
        {selected
          ? <RequestEditor key={selected.id} request={selected} onDraft={onDraft} onBusy={(value) => { setBusy(value); onBusy(value); }} onSaved={() => {
              setSelectedId(null); setNotice('请求已更新'); void requests.reload(); onChanged();
            }} />
          : <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">选择一条请求，确认受理或填写答复。</p>}
      </div>
      {notice ? <p role="status" className="text-sm text-emerald-700">{notice}</p> : null}
    </div>
  );
}

function RequestEditor({ request, onBusy, onSaved, onDraft }: { request: ServiceRequest; onBusy: (busy: boolean) => void; onSaved: () => void; onDraft: (id: string) => void }) {
  const [answer, setAnswer] = useState(request.answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(status: ServiceRequest['status']) {
    if (status === '已解决' && !answer.trim()) { setError('请填写处理答复。'); return; }
    setBusy(true); onBusy(true); setError('');
    try {
      await api('/api/modules/hr/requests/' + request.id, { method: 'PATCH', body: { status, answer } });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  return (
    <div className="space-y-4">
    <form onSubmit={(e) => { e.preventDefault(); void save('已解决'); }} className="space-y-3 rounded-lg border border-slate-200 p-4" aria-busy={busy}>
      <h3 className="text-sm font-semibold text-slate-800">{request.question}</h3>
      {request.history?.length ? <details className="text-sm text-slate-500"><summary className="cursor-pointer">前序提问</summary><ul className="mt-2 list-inside list-disc">{request.history.map((text, i) => <li key={i}>{text}</li>)}</ul></details> : null}
      <label className="block text-sm text-slate-600">处理答复
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} maxLength={4000} disabled={busy} className={FIELD} placeholder="写下已核实的信息与后续办理步骤" />
      </label>
      {request.handledBy ? <p className="text-xs text-slate-500">上次处理：{request.handledBy}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void save('处理中')} className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">{request.status === '已解决' ? '重新处理' : '确认受理'}</button>
        <button type="submit" disabled={busy} className={BUTTON}>{busy ? '保存中…' : '保存答复并解决'}</button>
      </div>
    </form>
    {request.status === '已解决' && request.answer ? <details>
      <summary className="cursor-pointer text-sm font-medium text-brand-700">整理为通用 FAQ 草稿</summary>
      <div className="mt-3"><KnowledgeEditor sourceRequest={request} onBusy={onBusy} onSaved={(version) => onDraft(version.id)} /></div>
    </details> : null}
    </div>
  );
}

function TalentWorkbench({ mode, onBusy }: { mode: 'recruitment' | 'training'; onBusy: (busy: boolean) => void }) {
  const roles = useApi<RoleProfile[]>('/api/modules/hr/roles');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const role = roles.data?.find((r) => r.positionId === roleId) ?? roles.data?.[0];
  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-slate-500">{mode === 'recruitment' ? '依据岗位要求逐项核对技能和相关经验，面试与录用由 HR 和用人部门确认。' : '根据已评估的技能差距安排课程和考核，生成的行动项会加入待办。'}</p>
      {roles.error ? <p role="alert" className="text-sm text-red-700">{roles.error} <button type="button" onClick={() => void roles.reload()} className="underline">重试</button></p> : null}
      {!roles.data && roles.loading ? <Spinner /> : null}
      {roles.data?.length === 0 ? <Empty>尚未收录岗位要求</Empty> : null}
      {role ? <>
        <label className="block max-w-xl text-sm font-medium text-slate-700">目标岗位
          <select className={FIELD} value={role.positionId} disabled={busy} onChange={(e) => setRoleId(e.target.value)}>
            {roles.data?.map((r) => <option key={r.positionId} value={r.positionId}>{r.positionId} · {r.position.department} · {r.position.title}</option>)}
          </select>
        </label>
        <TalentForm key={role.positionId} role={role} mode={mode} onBusy={(value) => { setBusy(value); onBusy(value); }} />
      </> : null}
    </div>
  );
}

function TalentForm({ role, mode, onBusy }: { role: RoleProfile; mode: 'recruitment' | 'training'; onBusy: (busy: boolean) => void }) {
  const [candidateId, setCandidateId] = useState('');
  const [years, setYears] = useState('');
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [turn, setTurn] = useState<Turn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clearResult = () => { setTurn(null); setError(''); };
  async function run(question: string, agentId: string) {
    setBusy(true); onBusy(true); clearResult();
    try {
      const response = await api<{ turn: Turn }>('/api/agents/' + agentId + '/turns', { method: 'POST', body: { question } });
      setTurn(response.turn);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const skills = role.skills.filter((s) => levels[s.name] !== undefined && levels[s.name] !== '').map((s) => ({ name: s.name, level: Number(levels[s.name]) }));
    const body = mode === 'training'
      ? { positionId: role.positionId, skills }
      : { positionId: role.positionId, candidates: [{ id: candidateId.trim(), ...(years === '' ? {} : { experienceYears: Number(years) }), skills }] };
    void run(JSON.stringify(body), mode === 'training' ? 'hr.training' : 'hr.recruitment');
  }
  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
        <fieldset disabled={busy} className="space-y-4">
          <legend className="sr-only">{mode === 'recruitment' ? '候选人资料' : '岗位技能评估'}</legend>
          {mode === 'recruitment' ? <div className="grid max-w-xl gap-3 sm:grid-cols-2">
            <label className="text-sm text-slate-700">候选人编号
              <input required maxLength={40} value={candidateId} onChange={(e) => { setCandidateId(e.target.value); clearResult(); }} className={FIELD} placeholder="例如 C-01" />
            </label>
            <label className="text-sm text-slate-700">相关工作年限
              <input type="number" min={0} max={60} step="0.5" value={years} onChange={(e) => { setYears(e.target.value); clearResult(); }} className={FIELD} placeholder="未提供可留空" />
            </label>
          </div> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            {role.skills.map((skill) => (
              <label key={skill.name} className="rounded-lg border border-slate-200 p-3 text-sm font-medium text-slate-700">
                {skill.name}<span className="ml-2 text-xs font-normal text-slate-500">目标 {skill.level} 级</span>
                <select aria-label={skill.name + '当前等级'} value={levels[skill.name] ?? ''} onChange={(e) => { setLevels((old) => ({ ...old, [skill.name]: e.target.value })); clearResult(); }} className={FIELD}>
                  <option value="">未评估</option>
                  {LEVELS.map((label, i) => <option key={label} value={i}>{label}</option>)}
                </select>
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-500">只填写已确认的评估。未填写的技能会列为待核；0 级表示已确认尚未掌握。</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={BUTTON}>{busy ? '生成中…' : mode === 'training' ? '生成培训计划与待办' : '生成初筛核对表'}</button>
            {mode === 'recruitment' ? <button type="button" onClick={() => void run('为 ' + role.positionId + ' 生成 JD', 'hr.recruitment')} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">生成岗位 JD</button> : null}
          </div>
        </fieldset>
      </form>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {turn ? <section className="space-y-4 border-t border-slate-100 pt-4" aria-label="分析结果" aria-live="polite">
        <h3 className="font-semibold text-slate-900">{turn.result.title}</h3>
        <Answer markdown={turn.result.answer} />
        <Evidence result={turn.result} />
        <Artifacts result={turn.result} />
        <Actions result={turn.result} />
        <Link to={'/agents/' + turn.agentId + '/' + turn.conversationId} className="inline-block text-sm text-brand-700 hover:underline">查看本次分析记录 →</Link>
      </section> : null}
    </div>
  );
}
