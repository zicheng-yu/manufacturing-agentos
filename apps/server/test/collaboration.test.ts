import type { AgentOSEvent, Signal } from '@agentos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestEvent } from '../src/core/events.ts';
import { listMemoryForTurns, listTasks, remember } from '../src/core/memory.ts';
import { buildMessages } from '../src/core/agents/prompt.ts';
import { crossDomainEvidence } from '../src/executive/briefing.ts';
import { OFFICIAL_STORYLINE } from '../src/seed/storyline.ts';
import { setup, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(() => { env = setup(); });
afterEach(() => env.deps.db.close());
async function ask(agent: string, question: string, conversationId?: string) {
  const result = await env.send('POST', `/api/agents/${agent}/turns`, { question, conversationId }, { Cookie: await env.login('chairman') });
  expect(result.status).toBe(200);
  return result.body;
}
function signal(e: AgentOSEvent): Signal {
  return { id: `SIG-${e.id}`, ruleId: 'test', domain: e.domain, severity: e.severity, title: e.title, summary: e.summary, eventIds: [e.id], count: 1, status: 'active', firstAt: e.createdAt, lastAt: e.lastSeenAt, updatedAt: e.lastSeenAt };
}

describe('conversation memory and trusted execution boundaries', () => {
  it('keeps identical facts in both conversations and preserves shared tasks/events when one turn is deleted', async () => {
    await env.bridge('/api/bridge/events', { domain: 'supply', type: 'inbound_delay', payload: { orderId: 'PO-2611', materialCode: 'FPC-1203', delayDays: 3 } });
    const first = await ask('supply.inventory', 'FPC-1203库存够几天？');
    const second = await ask('supply.inventory', 'FPC-1203库存够几天？');
    expect(first.conversation.id).not.toBe(second.conversation.id);
    const firstMemory = listMemoryForTurns(env.deps.db, [first.turn.id]);
    const secondMemory = listMemoryForTurns(env.deps.db, [second.turn.id]);
    expect(firstMemory.length).toBeGreaterThan(0);
    expect(secondMemory.map((m) => [m.kind, m.content])).toEqual(firstMemory.map((m) => [m.kind, m.content]));
    const tasks = listTasks(env.deps.db, ['supply']);
    expect(tasks.length).toBeGreaterThan(0);
    expect(second.turn.result.eventIds.length).toBeGreaterThan(0);
    const cookie = await env.login('chairman');
    expect((await env.send('DELETE', `/api/turns/${first.turn.id}`, undefined, { Cookie: cookie })).status).toBe(200);
    expect(listMemoryForTurns(env.deps.db, [second.turn.id]).length).toBe(secondMemory.length);
    expect(listTasks(env.deps.db, ['supply']).map((t) => t.title)).toEqual(tasks.map((t) => t.title));
    for (const id of second.turn.result.eventIds) expect(env.deps.db.prepare('SELECT id FROM events WHERE id = ?').get(id)).toBeTruthy();
    expect((await env.send('DELETE', `/api/turns/${second.turn.id}`, undefined, { Cookie: cookie })).status).toBe(200);
    expect(listTasks(env.deps.db, ['supply'])).toEqual([]);
  });

  it('keeps fact/pending/suggestion distinct, preserves decimal points and deduplicates only within the same source turn', () => {
    const base = { domain: 'supply' as const, source: 'agent' as const, agentId: 'supply.inventory', turnId: 'test' };
    const add = (kind: 'fact' | 'pending' | 'suggestion', content: string) => remember(env.deps.db, { ...base, kind, content }, env.deps.clock());
    expect(add('fact', '库存够1.2天')).toBeTruthy();
    expect(add('fact', '库存够12天')).toBeTruthy();
    expect(add('pending', '库存够1.2天')).toBeTruthy();
    expect(add('suggestion', '库存够1.2天')).toBeTruthy();
    expect(add('fact', ' 库存够1.2天 ')).toBeNull();
    expect(listMemoryForTurns(env.deps.db, ['test'])).toHaveLength(4);
  });

  it('does not promote model-only claims and actions when verified analysis is empty', async () => {
    env.deps.provider = { mode: 'llm', model: 'test-double', async complete() { return JSON.stringify({ title: '测试', answer: '仅测试结构化边界', facts: ['设备绝不会故障'], actions: [{ title: '立即停机', owner: '未经核实的人' }], pending: [], suggestions: [] }); } };
    const result = await ask('production.equipment', '设备怎么样？');
    expect(result.turn.result.facts).toEqual([]);
    expect(result.turn.result.actions).toEqual([]);
    expect(result.turn.result.pending.some((p: string) => p.includes('模型待核线索'))).toBe(true);
    expect(result.turn.result.suggestions.some((p: string) => p.includes('模型建议（未建待办）'))).toBe(true);
    expect(listTasks(env.deps.db, ['production'])).toEqual([]);
    expect(listMemoryForTurns(env.deps.db, [result.turn.id]).some((m) => m.kind === 'fact')).toBe(false);
  });

  it('labels historical pending and suggestions as unconfirmed and retains source timestamps', () => {
    const messages = buildMessages({ company: env.deps.company, agent: env.deps.registry.agent('supply.inventory'), context: { blocks: [] }, question: '继续', today: '2026-10-30', history: [], memory: [{ id: 'm', domain: 'supply', kind: 'pending', content: '交期尚待确认', source: 'agent', agentId: 'supply.inventory', turnId: 't1', createdAt: '2026-10-29T00:00:00Z' }] });
    const prompt = messages.at(-1)!.content;
    expect(prompt).toContain('含未确认事项，不代表当前状态');
    expect(prompt).toContain('[待核；2026-10-29T00:00:00Z；来源t1]');
    expect(messages[0].content).toContain('本轮业务数据优先于历史回答');
  });
});

describe('cross-domain evidence', () => {
  it('does not associate a material code with a coincidentally equal supplier name', () => {
    const one = ingestEvent(env.deps, { domain: 'supply', type: 'inbound_delay', title: '待核延迟', payload: { materialCode: 'SAME', orderId: 'unknown', delayDays: 1 }, source: { channel: 'manual' } }).event;
    const two = ingestEvent(env.deps, { domain: 'logistics', type: 'backlog_high', title: '积压', payload: { supplierName: 'SAME', backlog: 50 }, source: { channel: 'manual', station: '入库暂存区' } }).event;
    expect(crossDomainEvidence(env.deps, [signal(one), signal(two)])).toEqual([]);
  });

  it('joins supplier aliases while keeping entity links distinct from common cause labels', () => {
    const one = ingestEvent(env.deps, { domain: 'supply', type: 'inbound_delay', title: '到货延迟', payload: { supplier: ' 共同供应商 ', orderId: 'unknown', delayDays: 1, causes: ['缺料待料'] }, source: { channel: 'manual' } }).event;
    const two = ingestEvent(env.deps, { domain: 'logistics', type: 'backlog_high', title: '积压', payload: { supplierName: '共同供应商', backlog: 50, causes: ['缺料待料'] }, source: { channel: 'manual', station: '入库暂存区' } }).event;
    const links = crossDomainEvidence(env.deps, [signal(one), signal(two)]);
    expect(links.map((l) => l.kind)).toEqual(['共同供应商', '共同原因标签']);
    expect(links.every((l) => l.sources.map((s) => s.eventId).includes(one.id) && l.sources.map((s) => s.eventId).includes(two.id))).toBe(true);
    expect(links.every((l) => l.summary.includes('关联不代表已验证因果'))).toBe(true);
  });

  it('keeps the official storyline decisions and supplies traceable collaboration evidence', async () => {
    const official = setup(new Date('2026-10-30T09:00:00+08:00'), 'official');
    try {
      for (const step of OFFICIAL_STORYLINE) { expect((await official.bridge(step.path, step.body)).status).toBe(200); official.advance(0.5); }
      const result = await official.send('POST', '/api/cockpit/briefing', {}, { Cookie: await official.login('chairman') });
      expect(result.status).toBe(200);
      expect(result.body.turn.result.artifacts[0].rows).toHaveLength(3);
      const evidence = result.body.turn.result.artifacts.find((a: { title: string }) => a.title === '跨部门关联证据');
      expect(evidence.rows.length).toBeGreaterThan(0);
      for (const row of evidence.rows) {
        expect(official.deps.db.prepare('SELECT id FROM signals WHERE id = ?').get(row[3])).toBeTruthy();
        expect(official.deps.db.prepare('SELECT id FROM events WHERE id = ?').get(row[4])).toBeTruthy();
      }
    } finally { official.deps.db.close(); }
  });
});
