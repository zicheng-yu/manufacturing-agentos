import type { Account, AgentResult, Conversation, Domain, Turn } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { parseJson, transaction, type Row } from '../../db.ts';
import { COMPANY } from '../../seed/company.ts';
import type { Deps } from '../deps.ts';
import { ingestEvent } from '../events.ts';
import { addTask, listMemory, remember } from '../memory.ts';
import { canSee, domainsFor } from '../roles.ts';
import { evaluateDomain } from '../signals.ts';
import { isoDate, newId, unique } from '../util.ts';
import { buildMessages, offlineDraft, parseModelOutput, type DraftResult } from './prompt.ts';

const HISTORY_TURNS = 6;
const MEMORY_RECORDS = 20;

/** Ignore whitespace and punctuation so a model's rephrasing of a known item counts as a duplicate. */
const normalize = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Context items first, then the model's additions; drops near-duplicates and boilerplate. */
function mergeItems(context: string[] | undefined, model: string[], limit: number): string[] {
  return unique([...(context ?? []), ...model].filter((item) => item && !item.includes('演示数据')), normalize).slice(0, limit);
}

export function rowToConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToTurn(row: Row): Turn {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    agentId: String(row.agent_id),
    input: String(row.input),
    result: parseJson<AgentResult>(row.result_json, {
      title: '',
      answer: '',
      facts: [],
      pending: [],
      suggestions: [],
      actions: [],
      artifacts: [],
      eventIds: [],
    }),
    mode: row.mode as Turn['mode'],
    latencyMs: Number(row.latency_ms),
    createdAt: String(row.created_at),
  };
}

export function getConversation(deps: Deps, account: Account, id: string): Conversation {
  const row = deps.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
  if (!row || (row.account_id !== account.id && account.role !== 'executive')) {
    throw new HTTPException(404, { message: '对话不存在' });
  }
  return rowToConversation(row);
}

export function listTurns(deps: Deps, conversationId: string): Turn[] {
  const rows = deps.db.prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as Row[];
  return rows.map(rowToTurn);
}

/** Run one question through an agent: analysis → model (or offline) → persist memory, tasks and events. */
export async function runTurn(
  deps: Deps,
  input: { account: Account; agentId: string; conversationId?: string | null; question: string },
): Promise<{ conversation: Conversation; turn: Turn }> {
  const { account } = input;
  const agent = deps.registry.agent(input.agentId);
  if (!canSee(account.role, agent.module)) throw new HTTPException(403, { message: '当前账号无权使用该智能体' });
  const question = input.question.trim();
  if (!question) throw new HTTPException(400, { message: '问题不能为空' });

  const now = deps.clock();
  let conversation: Conversation;
  if (input.conversationId) {
    conversation = getConversation(deps, account, input.conversationId);
    if (conversation.agentId !== agent.id) throw new HTTPException(400, { message: '对话不属于该智能体' });
  } else {
    const id = newId('CNV');
    deps.db
      .prepare('INSERT INTO conversations (id, account_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, account.id, agent.id, question.slice(0, 24), now.toISOString(), now.toISOString());
    conversation = getConversation(deps, account, id);
  }

  const started = Date.now();
  const context = agent.context({ db: deps.db, now, input: question, account, deps });
  const scopes = agent.module === 'executive' ? [...domainsFor(account.role), 'executive' as const] : [agent.module];
  const history = listTurns(deps, conversation.id)
    .slice(-HISTORY_TURNS)
    .map((t) => ({ input: t.input, answer: t.result.answer }));

  let mode: Turn['mode'] = deps.provider.mode;
  let draft: DraftResult;
  if (deps.provider.mode === 'llm') {
    try {
      const raw = await deps.provider.complete(
        buildMessages({
          company: COMPANY,
          agent,
          context,
          memory: listMemory(deps.db, scopes, MEMORY_RECORDS),
          history,
          question,
          today: isoDate(now),
        }),
      );
      draft = parseModelOutput(raw);
    } catch (error) {
      mode = 'offline';
      draft = offlineDraft(agent, context);
      draft.pending.push(`模型调用失败，已按规则分析作答：${(error as Error).message}`);
    }
  } else {
    draft = offlineDraft(agent, context);
  }

  const turnId = newId('TURN');
  const result: AgentResult = {
    title: draft.title || context.headline || agent.name,
    answer: draft.answer,
    facts: mergeItems(context.facts, draft.facts, 8),
    pending: mergeItems(context.pending, draft.pending, 6),
    suggestions: mergeItems(context.suggestions, draft.suggestions, 6),
    actions: unique([...(context.actions ?? []), ...draft.actions], (a) => normalize(a.title)).slice(0, Math.max(5, context.actions?.length ?? 0)),
    artifacts: context.artifacts ?? [],
    eventIds: [],
  };

  for (const event of context.events ?? []) {
    const { event: stored } = ingestEvent(deps, {
      ...event,
      source: { ...event.source, actor: event.source.actor ?? agent.name },
      turnId,
    });
    result.eventIds.push(stored.id);
  }

  const createdTasks = transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, account_id, agent_id, input, result_json, mode, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(turnId, conversation.id, account.id, agent.id, question, JSON.stringify(result), mode, Date.now() - started, now.toISOString());
    deps.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now.toISOString(), conversation.id);
    const base = { domain: agent.module, source: 'agent' as const, agentId: agent.id, turnId };
    for (const content of result.facts) remember(deps.db, { ...base, kind: 'fact', content }, now);
    for (const content of result.pending) remember(deps.db, { ...base, kind: 'pending', content }, now);
    for (const content of result.suggestions) remember(deps.db, { ...base, kind: 'suggestion', content }, now);
    return result.actions
      .map((a) => addTask(deps.db, { domain: agent.module, title: a.title, owner: a.owner, due: a.due, turnId }, now))
      .filter((t) => t !== null);
  });
  for (const task of createdTasks) deps.bus.publish({ kind: 'task.created', task });

  const turn = rowToTurn(deps.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as Row);
  return { conversation: getConversation(deps, account, conversation.id), turn };
}

/** Deleting a turn also removes the memory, tasks and events it produced. */
export function deleteTurn(deps: Deps, account: Account, turnId: string): void {
  const row = deps.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as Row | undefined;
  if (!row || (row.account_id !== account.id && account.role !== 'executive')) {
    throw new HTTPException(404, { message: '记录不存在' });
  }
  const domains = (deps.db.prepare('SELECT DISTINCT domain FROM events WHERE turn_id = ?').all(turnId) as Row[]).map(
    (r) => r.domain as Domain,
  );
  transaction(deps.db, () => {
    deps.db.prepare('DELETE FROM memory WHERE turn_id = ?').run(turnId);
    deps.db.prepare('DELETE FROM tasks WHERE turn_id = ?').run(turnId);
    deps.db.prepare('DELETE FROM events WHERE turn_id = ?').run(turnId);
    deps.db.prepare('DELETE FROM turns WHERE id = ?').run(turnId);
  });
  for (const domain of domains) evaluateDomain(deps, domain);
}
