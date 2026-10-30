import { DOMAINS, type AgentInfo, type Conversation, type Turn } from '@agentos/shared';
import { MessageSquarePlus, SendHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, useApi } from '../api.ts';
import { Actions, Answer, Artifacts, Evidence, PolicySources } from '../components/ResultView.tsx';
import { useSession } from '../session.tsx';
import { cx, DOMAIN_ICONS, Empty, scopeLabel, Spinner, timeAgo } from '../ui.tsx';

const STEPS = ['读取业务数据', '读取共享记忆', '规则分析', '撰写结论'];

function Thinking() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 900);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
      <Spinner className="size-3.5 text-brand-600" />
      {STEPS.map((s, i) => (
        <span key={s} className={i <= step ? 'text-brand-700' : 'text-slate-300'}>
          {i < step ? '✓ ' : ''}
          {s}
        </span>
      ))}
    </div>
  );
}

function TurnView({ turn, onDelete }: { turn: Turn; onDelete: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white">{turn.input}</div>
      </div>
      <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-slate-900">{turn.result.title}</h3>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-slate-400">
            <span>{turn.result.policy ? (turn.mode === 'llm' ? 'AI 检索' : '制度检索') : (turn.mode === 'llm' ? '模型撰写' : '规则分析')} · {(turn.latencyMs / 1000).toFixed(1)} 秒</span>
            <button
              onClick={() => {
                if (confirm('删除这一轮问答？它写入的记忆、待办和事件会一并删除。')) onDelete();
              }}
              className="rounded p-1 hover:bg-slate-100 hover:text-red-600"
              title="删除本轮"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
        <Answer markdown={turn.result.answer} />
        <PolicySources result={turn.result} />
        <Artifacts result={turn.result} />
        <Evidence result={turn.result} />
        <Actions result={turn.result} />
        {turn.result.eventIds.length > 0 && (
          <p className="text-xs text-slate-500">
            本轮产生 {turn.result.eventIds.length} 个事件，已进入
            <Link to="/events" className="mx-1 text-brand-600 hover:underline">
              事件中心
            </Link>
            并参与上卷
          </p>
        )}
      </article>
    </div>
  );
}

export function Agents() {
  const { catalog } = useSession();
  const navigate = useNavigate();
  const params = useParams();
  const agents = catalog?.agents ?? [];
  const agent: AgentInfo | undefined = agents.find((a) => a.id === params.agentId) ?? agents[0];
  const conversationId = params.conversationId ?? null;

  const conversations = useApi<Conversation[]>(agent ? `/api/conversations?agentId=${agent.id}` : null);
  const detail = useApi<{ conversation: Conversation; turns: Turn[] }>(conversationId ? `/api/conversations/${conversationId}` : null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const turns = conversationId ? (detail.data?.turns ?? []) : [];

  useEffect(() => {
    setError(null);
  }, [conversationId, agent?.id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length, pending]);

  const groups = useMemo(() => {
    const order = ['executive', ...DOMAINS] as const;
    return order
      .map((scope) => ({ scope, agents: agents.filter((a) => a.module === scope) }))
      .filter((g) => g.agents.length > 0);
  }, [agents]);

  async function ask(question: string) {
    if (!agent || !question.trim() || pending) return;
    setPending(question);
    setDraft('');
    setError(null);
    try {
      const res = await api<{ conversation: Conversation; turn: Turn }>(`/api/agents/${agent.id}/turns`, {
        method: 'POST',
        body: { question, conversationId },
      });
      if (conversationId) {
        detail.setData((prev) => (prev ? { ...prev, turns: [...prev.turns, res.turn] } : prev));
      } else {
        navigate(`/agents/${agent.id}/${res.conversation.id}`);
      }
      void conversations.reload();
    } catch (e) {
      setError((e as Error).message);
      setDraft(question);
    } finally {
      setPending(null);
    }
  }

  async function removeTurn(turn: Turn) {
    await api(`/api/turns/${turn.id}`, { method: 'DELETE' });
    detail.setData((prev) => (prev ? { ...prev, turns: prev.turns.filter((t) => t.id !== turn.id) } : prev));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  if (!agent) return <Empty>当前账号没有可用的智能体</Empty>;
  const Icon = DOMAIN_ICONS[agent.module];

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Agents and conversations */}
      <aside className="shrink-0 overflow-y-auto border-b border-slate-200 bg-white lg:w-64 lg:border-r lg:border-b-0">
        <div className="space-y-4 p-3">
          {groups.map((g) => {
            const GroupIcon = DOMAIN_ICONS[g.scope];
            return (
              <div key={g.scope}>
                <div className="mb-1 flex items-center gap-1.5 px-2 text-[11px] font-medium text-slate-400">
                  <GroupIcon className="size-3" />
                  {scopeLabel(g.scope)}
                </div>
                {g.agents.map((a) => (
                  <Link
                    key={a.id}
                    to={`/agents/${a.id}`}
                    className={cx('block rounded-lg px-2 py-1.5 text-sm', a.id === agent.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-50')}
                  >
                    {a.name}
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
        <div className="border-t border-slate-100 p-3">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-slate-400">对话</span>
            <Link to={`/agents/${agent.id}`} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
              <MessageSquarePlus className="size-3.5" />
              新对话
            </Link>
          </div>
          {(conversations.data ?? []).map((c) => (
            <Link
              key={c.id}
              to={`/agents/${agent.id}/${c.id}`}
              className={cx('block rounded-lg px-2 py-1.5', c.id === conversationId ? 'bg-slate-100' : 'hover:bg-slate-50')}
            >
              <div className="truncate text-[13px] text-slate-700">{c.title}</div>
              <div className="text-[11px] text-slate-400">{timeAgo(c.updatedAt)}</div>
            </Link>
          ))}
          {conversations.data?.length === 0 && <p className="px-2 py-2 text-xs text-slate-400">还没有对话</p>}
        </div>
      </aside>

      {/* Conversation */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Icon className="size-4.5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-slate-900">{agent.name}</h1>
            <p className="truncate text-xs text-slate-500">{agent.description}</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
          {turns.length === 0 && !pending && (
            <div className="mx-auto max-w-xl pt-8 text-center">
              <p className="text-sm text-slate-500">直接描述情况或提问。回答会区分事实、待核信息与建议，行动项自动进入待办。</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {agent.starters.map((s) => (
                  <button key={s} onClick={() => void ask(s)} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-brand-300 hover:text-brand-700">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} onDelete={() => void removeTurn(t)} />
          ))}
          {pending && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm text-white">{pending}</div>
              </div>
              <Thinking />
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div ref={bottom} />
          </div>
        </div>
        <form onSubmit={submit} className="border-t border-slate-200 bg-white p-3">
          <div className="mx-auto flex max-w-5xl items-end gap-2 rounded-xl border border-slate-300 bg-white p-2 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(draft);
                }
              }}
              rows={2}
              placeholder={`向${agent.name}提问，Enter 发送，Shift+Enter 换行`}
              className="min-h-10 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
            />
            <button disabled={!draft.trim() || !!pending} className="rounded-lg bg-brand-600 p-2 text-white hover:bg-brand-700 disabled:opacity-40">
              <SendHorizontal className="size-4" />
            </button>
          </div>
        </form>
      </section>

    </div>
  );
}
