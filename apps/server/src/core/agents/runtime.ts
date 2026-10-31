import type { Account, AgentResult, Conversation, Domain, Turn } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { parseJson, transaction, type Row } from '../../db.ts';
import type { Deps } from '../deps.ts';
import { ingestEvent } from '../events.ts';
import { addTask, listMemoryForTurns, remember } from '../memory.ts';
import { canUseAgent } from '../roles.ts';
import { evaluateDomain } from '../signals.ts';
import { isoDate, newId, normalizeText, unique } from '../util.ts';
import { buildMessages, offlineDraft, parseModelOutput, partialAnswer, type DraftResult } from './prompt.ts';

import { resolveReference } from './handoff.ts';

const HISTORY_TURNS = 6;
const MODEL_ACTIONS = 3;
const MEMORY_RECORDS = 20;

const normalize = normalizeText;

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
  input: { account: Account; agentId: string; conversationId?: string | null; question: string; sourceTurnId?: string | null; sourceFindingId?: string | null; onAnswer?: (text: string) => void },
): Promise<{ conversation: Conversation; turn: Turn }> {
  const { account } = input;
  const agent = deps.registry.agent(input.agentId);
  if (!canUseAgent(account.role, agent)) throw new HTTPException(403, { message: '当前账号无权使用该智能体' });
  const question = input.question.trim();
  if (!question) throw new HTTPException(400, { message: '问题不能为空' });

  const now = deps.clock();
  if (input.sourceFindingId && !input.sourceTurnId) throw new HTTPException(400, { message: '数据发现需要来源问答' });
  if (input.conversationId && input.sourceTurnId) throw new HTTPException(400, { message: '请在新对话中接续另一位助手' });
  let reference = input.sourceTurnId ? await resolveReference(deps, account, input.sourceTurnId, input.sourceFindingId) : null;
  let referenceNotice: string | null = null;
  let conversation: Conversation;
  if (input.conversationId) {
    conversation = getConversation(deps, account, input.conversationId);
    if (conversation.agentId !== agent.id) throw new HTTPException(400, { message: '对话不属于该智能体' });
    const origin = deps.db.prepare('SELECT reference_turn_id, reference_finding_id FROM conversations WHERE id = ?').get(conversation.id) as Row;
    if (origin.reference_turn_id) {
      try { reference = await resolveReference(deps, account, String(origin.reference_turn_id), origin.reference_finding_id as string | null); }
      catch { referenceNotice = '接续来源已过期、删除或不可访问，本轮仅依据当前业务数据；请重新运行来源助手。'; }
    }
  } else {
    const id = newId('CNV');
    deps.db
      .prepare('INSERT INTO conversations (id, account_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, account.id, agent.id, question.slice(0, 24), now.toISOString(), now.toISOString());
    conversation = getConversation(deps, account, id);
    if (input.sourceTurnId) deps.db.prepare('UPDATE conversations SET reference_turn_id = ?, reference_finding_id = ? WHERE id = ?').run(input.sourceTurnId, input.sourceFindingId ?? null, id);
  }

  const started = Date.now();
  const earlier = listTurns(deps, conversation.id).slice(-HISTORY_TURNS);
  const context = await agent.context({ db: deps.db, now, input: question, history: earlier.map((t) => t.input), account, deps });
  if (reference) {
    context.blocks.unshift({ title: '从另一助手接续的分析（不是已执行结果）', lines: [reference.reference.summary] });
    if (reference.finding) {
      const evidence = reference.finding.evidence;
      context.blocks.push({ title: `接续发现的计算证据：${evidence.title}`, lines: [evidence.columns.join(' | '), ...evidence.rows.map(row => row.join(' | '))] });
      context.artifacts = [evidence, ...(context.artifacts ?? [])];
    }
  }
  if (referenceNotice) context.pending = [...(context.pending ?? []), referenceNotice];
  const history = earlier.map((t) => ({ input: t.input, answer: t.result.answer }));
  // Only this conversation's working memory: other conversations' figures go stale and leak into answers.
  const memory = listMemoryForTurns(deps.db, earlier.filter(t => now.getTime() - Date.parse(t.createdAt) <= 30 * 60_000).map((t) => t.id)).slice(-MEMORY_RECORDS);

  let mode: Turn['mode'] = deps.provider.mode;
  let draft: DraftResult;
  if (context.preparedResponse) {
    mode = context.preparedResponse.mode;
    draft = { ...offlineDraft(agent, context), answer: context.preparedResponse.answer };
  } else if (deps.provider.mode === 'llm') {
    try {
      const messages = buildMessages({ company: deps.company, agent, context, memory, history, question, today: isoDate(now) });
      let raw: string;
      if (input.onAnswer && deps.provider.stream) {
        // Pass on the answer text as the model writes it; the parsed result below is still what gets saved.
        let generated = '';
        let shown = '';
        raw = await deps.provider.stream(messages, (chunk) => {
          generated += chunk;
          const answer = partialAnswer(generated);
          if (answer.length > shown.length) {
            input.onAnswer!(answer.slice(shown.length));
            shown = answer;
          }
        });
      } else {
        raw = await deps.provider.complete(messages);
      }
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
    // Only computed/verified context can establish facts or execution tasks, including when it is empty.
    facts: (context.facts ?? []).slice(0, 20),
    pending: mergeItems(context.pending, [...draft.pending, ...draft.facts.map((f) => `模型待核线索（未经业务验证）：${f}`)], 6),
    suggestions: mergeItems(context.suggestions, [...draft.suggestions, ...draft.actions.slice(0, MODEL_ACTIONS).map((a) => `模型建议（未建待办）：${a.title}`)], 6),
    actions: context.actions ?? [],
    artifacts: context.artifacts ?? [],
    eventIds: [],
    ...(context.policy ? { policy: context.policy } : {}),
    ...(context.discoveries ? { discoveries: context.discoveries } : {}),
    ...(reference ? { reference: reference.reference } : {}),
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
    // Transfer a deduplicated task to another referring turn before removing this turn's own records.
    deps.db.prepare(`UPDATE tasks SET turn_id = (
      SELECT turn_id FROM task_turn_sources WHERE task_id = tasks.id AND turn_id <> ? ORDER BY turn_id LIMIT 1
    ) WHERE turn_id = ? AND EXISTS (SELECT 1 FROM task_turn_sources WHERE task_id = tasks.id AND turn_id <> ?)`)
      .run(turnId, turnId, turnId);
    deps.db.prepare('DELETE FROM task_turn_sources WHERE turn_id = ?').run(turnId);
    deps.db.prepare('DELETE FROM tasks WHERE turn_id = ?').run(turnId);
    // result.eventIds records the actual shared event references, including merged state events.
    deps.db.prepare(`UPDATE events SET turn_id = (
      SELECT t.id FROM turns t, json_each(t.result_json, '$.eventIds') ref
      WHERE t.id <> ? AND ref.value = events.id ORDER BY t.created_at, t.id LIMIT 1
    ) WHERE turn_id = ? AND EXISTS (
      SELECT 1 FROM turns t, json_each(t.result_json, '$.eventIds') ref WHERE t.id <> ? AND ref.value = events.id
    )`).run(turnId, turnId, turnId);
    deps.db.prepare('DELETE FROM events WHERE turn_id = ?').run(turnId);
    deps.db.prepare('DELETE FROM turns WHERE id = ?').run(turnId);
  });
  for (const domain of domains) evaluateDomain(deps, domain);
}
