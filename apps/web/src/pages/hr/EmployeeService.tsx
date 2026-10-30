import type { Conversation, Turn } from '@agentos/shared';
import { useState, type FormEvent } from 'react';
import { api, useApi } from '../../api.ts';
import { Answer, PolicySources } from '../../components/ResultView.tsx';
import { Card, Empty, Spinner } from '../../ui.tsx';

interface MyRequest { id: string; question: string; status: string; answer: string; updatedAt: string | null; }
const OUTCOME = { answered: '已引用制度', clarify: '待补充信息', handoff: '已转 HR' };

export function EmployeeService() {
  const conversations = useApi<Conversation[]>('/api/conversations?agentId=hr.service');
  const requests = useApi<MyRequest[]>('/api/modules/hr/service/requests');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState('');

  async function loadConversation(id: string) {
    setBusy(true); setError('');
    try {
      if (!id) { setConversationId(null); setTurns([]); return; }
      const data = await api<{ turns: Turn[]; conversation: Conversation }>('/api/conversations/' + id);
      if (data.conversation.agentId !== 'hr.service') throw new Error('请选择制度助手的对话');
      setConversationId(id); setTurns(data.turns);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function ask(input: string) {
    if (busy || !input.trim()) return;
    setBusy(true); setError(''); setPendingQuestion(input);
    try {
      const data = await api<{ conversation: Conversation; turn: Turn }>('/api/agents/hr.service/turns', {
        method: 'POST', body: { question: input.trim(), conversationId },
      });
      setConversationId(data.conversation.id); setTurns((previous) => [...previous, data.turn]);
      setQuestion(''); void conversations.reload(); void requests.reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setPendingQuestion(''); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void ask(question); }
  return <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">公司制度助手</h1>
      <p className="mt-2 text-sm text-slate-500">问假期、考勤、报销、入职等日常问题。按现行制度回答，带出处；需要 HR 时为你登记并保留答复。</p>
    </div>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
      <Card title="向制度助手提问">
        <div className="space-y-4 p-4">
          <label className="block text-xs text-slate-500">历史对话
            <select aria-label="制度助手历史对话" disabled={busy} value={conversationId ?? ''} onChange={(e) => void loadConversation(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-700">
              <option value="">新对话</option>
              {conversations.data?.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              {conversationId && !conversations.data?.some((c) => c.id === conversationId) ? <option value={conversationId}>当前对话</option> : null}
            </select>
          </label>
          {conversations.error ? <p role="alert" className="text-sm text-red-700">{conversations.error}</p> : null}
          {turns.length === 0 ? <div className="flex flex-wrap gap-2">
            {['我想请假', '年假有几天？', '出差住宿报销标准是多少', '公司有班车吗？'].map((text) => <button key={text} type="button" disabled={busy} onClick={() => void ask(text)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:border-brand-300">{text}</button>)}
          </div> : <p className="text-xs text-slate-400">历史回答保留当时引用的版本；新问题会重新查询现行制度。</p>}
          <div className="max-h-[600px] space-y-4 overflow-y-auto" aria-live="polite" aria-busy={busy}>
            {turns.map((turn) => <article key={turn.id} className="space-y-3">
              <p className="ml-8 rounded-xl bg-brand-600 px-4 py-3 text-sm whitespace-pre-wrap text-white">{turn.input}</p>
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                <div className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="font-medium text-brand-700">{turn.result.policy ? OUTCOME[turn.result.policy.outcome] : '制度问答'}</span>
                  <span className="text-slate-400">{turn.mode === 'llm' ? 'AI 检索' : '制度检索'} · {(turn.latencyMs / 1000).toFixed(1)} 秒</span>
                </div>
                <Answer markdown={turn.result.answer} />
                <PolicySources result={turn.result} />
              </div>
            </article>)}
            {pendingQuestion ? <p className="flex items-center gap-2 rounded-lg bg-brand-50 p-3 text-sm text-brand-700"><Spinner />正在核对现行制度：{pendingQuestion}</p> : null}
          </div>
          <form onSubmit={submit} className="space-y-2">
            <label className="block text-sm text-slate-600">你的问题
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={4000} rows={3} disabled={busy} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="描述要办的事情，或补充助手刚刚询问的信息" />
            </label>
            <button disabled={busy || !question.trim()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? '查询中…' : '发送问题'}</button>
            {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          </form>
        </div>
      </Card>
      <Card title="我的人工服务请求" action={<button type="button" disabled={requests.loading} onClick={() => void requests.reload()} className="text-xs text-brand-700">刷新进度</button>}>
        {requests.error ? <p role="alert" className="p-4 text-sm text-red-700">{requests.error}</p> : null}
        {!requests.data && requests.loading ? <div className="p-4"><Spinner /></div> : null}
        {requests.data?.length === 0 ? <Empty>需要 HR 核实时，请求会出现在这里。</Empty> : null}
        <ul className="divide-y divide-slate-100">
          {requests.data?.map((request) => <li key={request.id} className="space-y-2 p-4">
            <div className="flex justify-between gap-2 text-xs text-slate-500"><span>{request.id}</span><span>{request.status}</span></div>
            <p className="text-sm font-medium text-slate-800">{request.question}</p>
            {request.answer ? <p className="rounded-lg bg-emerald-50 p-3 text-sm whitespace-pre-wrap text-emerald-800">HR 答复：{request.answer}</p> : <p className="text-xs text-slate-400">等待 HR 核实答复。</p>}
          </li>)}
        </ul>
      </Card>
    </div>
  </div>;
}
