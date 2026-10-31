import type { Account, AgentResult, AnalysisReference, Discovery } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { parseJson, type Row } from '../../db.ts';
import type { Deps } from '../deps.ts';
import { canUseAgent } from '../roles.ts';

/** Explicit, same-account handoff. Discovery calculations are refreshed, never trusted from the stored snapshot. */
export async function resolveReference(deps: Deps, account: Account, turnId: string, findingId?: string | null): Promise<{ reference: AnalysisReference; finding?: Discovery }> {
  const row = deps.db.prepare('SELECT * FROM turns WHERE id = ? AND account_id = ?').get(turnId, account.id) as Row | undefined;
  if (!row) throw new HTTPException(404, { message: '接续来源不存在或不属于当前账号' });
  const sourceAgent = deps.registry.agent(String(row.agent_id));
  if (!canUseAgent(account.role, sourceAgent)) throw new HTTPException(403, { message: '无权引用该来源' });
  const result = parseJson<AgentResult>(row.result_json, {} as AgentResult);
  const reference: AnalysisReference = {
    turnId, conversationId: String(row.conversation_id), agentId: sourceAgent.id,
    createdAt: String(row.created_at), summary: '',
  };
  if (findingId) {
    if (sourceAgent.id !== 'executive.discoveries' || !result.discoveries?.some(d => d.id === findingId)) throw new HTTPException(400, { message: '来源中没有这项数据发现' });
    const current = await sourceAgent.context({ db: deps.db, now: deps.clock(), input: '', history: [], account, deps });
    const finding = current.discoveries?.find(d => d.id === findingId);
    if (!finding) throw new HTTPException(409, { message: '这项发现已不适用于当前数据，请重新分析' });
    reference.refreshedAt = deps.clock().toISOString();
    reference.summary = `【${finding.kind}】${finding.summary}\n来源：${finding.source}；${finding.scope}\n边界：${finding.limitation}`;
    return { reference, finding };
  }
  if (deps.clock().getTime() - Date.parse(reference.createdAt) > 30 * 60_000) throw new HTTPException(409, { message: '该分析已超过30分钟，请先重新运行来源助手再接续' });
  // Stored historical outputs are context, not new facts. Never forward an unchecked model-written answer.
  const facts = deps.db.prepare("SELECT content FROM memory WHERE turn_id = ? AND kind = 'fact' AND verified = 1 ORDER BY created_at LIMIT 6").all(turnId) as Row[];
  reference.summary = `来源问题：${String(row.input).slice(0, 1000)}\n历史计算快照（当前数据优先）：\n${facts.map(f => String(f.content)).join('\n') || '没有已计算事实；不可从历史回答补全事实'}`;
  return { reference };
}
