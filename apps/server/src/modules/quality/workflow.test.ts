import type { AgentResult } from '@agentos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEvents } from '../../core/events.ts';
import { evaluateDomain } from '../../core/signals.ts';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import { qualityDate, shiftDate } from './calendar.ts';
import { listCapa } from './data.ts';

let env: TestEnv;
beforeEach(() => { env = setup(); });
afterEach(() => { env.deps.db.close(); });

async function ask(question: string, conversationId?: string) {
  const cookie = await env.login('quality');
  const response = await env.send('POST', '/api/agents/quality.capa/turns', { question, conversationId }, { Cookie: cookie });
  expect(response.status).toBe(200);
  return response.body as { conversation: { id: string }; turn: { result: AgentResult } };
}

const planned = () => ({ title: '核实冷启动复现条件', owner: '品质负责人', due: shiftDate(qualityDate(env.deps.clock()), -1), confirmed: true });

describe('8D to confirmed corrective-action register', () => {
  it('does not turn a generated report into registered corrective actions without confirmation', async () => {
    const initial = listCapa(env.deps.db).length;
    const report = await ask('为CC-2610-09起草8D');
    expect(report.turn.result.pending.join(' ')).toContain('不等于已建档整改项');
    expect(listCapa(env.deps.db)).toHaveLength(initial);
    const { confirmed, ...draft } = planned();
    const response = await env.send('POST', '/api/modules/quality/complaints/CC-2610-09/capa', draft, { Cookie: await env.login('quality') });
    expect(response.status).toBe(400);
    expect(listCapa(env.deps.db)).toHaveLength(initial);
  });

  it('registers a confirmed item, immediately tracks past due work, and shows completion in the same complaint', async () => {
    const cookie = await env.login('quality');
    const response = await env.send('POST', '/api/modules/quality/complaints/CC-2610-09/capa', planned(), { Cookie: cookie });
    expect(response.status).toBe(201);
    expect(response.body.created).toBe(true);
    const id = response.body.capa.id;
    expect(response.body.capa.complaintId).toBe('CC-2610-09');
    expect(listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).some((e) => e.type === 'capa_overdue' && e.payload.capaId === id)).toBe(true);
    const before = await ask('CC-2610-09的整改完成了吗？');
    expect(before.turn.result.title).toContain('0/1');
    expect(before.turn.result.artifacts[0].rows.map((r) => r[0])).toEqual([id]);
    expect((await env.send('PATCH', `/api/modules/quality/capa/${id}`, { status: '已完成' }, { Cookie: cookie })).status).toBe(200);
    const after = await ask('CC-2610-09的整改完成了吗？');
    expect(after.turn.result.title).toContain('1/1');
    expect(listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).some((e) => e.type === 'capa_overdue' && e.payload.capaId === id)).toBe(false);
    expect(after.turn.result.facts.join(' ')).toContain('不等同于8D根因已验证');
  });

  it('reuses an identical confirmation and never reopens a completed item on a retry', async () => {
    const cookie = await env.login('quality');
    const path = '/api/modules/quality/complaints/CC-2610-09/capa';
    const initial = listCapa(env.deps.db).length;
    const responses = await Promise.all([env.send('POST', path, planned(), { Cookie: cookie }), env.send('POST', path, planned(), { Cookie: cookie })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const first = responses.find((r) => r.status === 201)!;
    const second = responses.find((r) => r.status === 200)!;
    expect(second.body.created).toBe(false);
    expect(second.body.capa.id).toBe(first.body.capa.id);
    expect(listCapa(env.deps.db)).toHaveLength(initial + 1);
    await env.send('PATCH', `/api/modules/quality/capa/${first.body.capa.id}`, { status: '已完成' }, { Cookie: cookie });
    const retry = await env.send('POST', path, planned(), { Cookie: cookie });
    expect(retry.body.capa.status).toBe('已完成');
    expect(retry.body.overdue).toBe(false);
  });

  it('keeps identical plans on two different complaints as separate records', async () => {
    const cookie = await env.login('quality');
    const first = await env.send('POST', '/api/modules/quality/complaints/CC-2610-09/capa', planned(), { Cookie: cookie });
    const second = await env.send('POST', '/api/modules/quality/complaints/CC-2610-05/capa', planned(), { Cookie: cookie });
    expect(second.status).toBe(201);
    expect(second.body.capa.id).not.toBe(first.body.capa.id);
  });

  it('checks access, complaint state and complete valid fields before creating a record', async () => {
    const path = '/api/modules/quality/complaints/CC-2610-09/capa';
    const initial = listCapa(env.deps.db).length;
    expect((await env.send('POST', path, planned())).status).toBe(401);
    expect((await env.send('POST', path, planned(), { Cookie: await env.login('supply') })).status).toBe(403);
    const cookie = await env.login('quality');
    for (const patch of [{ title: ' ' }, { owner: ' ' }, { due: '2026-02-30' }, { confirmed: false }, { extra: 'ignored?' }]) {
      expect((await env.send('POST', path, { ...planned(), ...patch }, { Cookie: cookie })).status).toBe(400);
    }
    expect((await env.send('POST', '/api/modules/quality/complaints/UNKNOWN/capa', planned(), { Cookie: cookie })).status).toBe(404);
    expect((await env.send('POST', '/api/modules/quality/complaints/CC-2609-21/capa', planned(), { Cookie: cookie })).status).toBe(409);
    expect(listCapa(env.deps.db)).toHaveLength(initial);
    expect((await env.send('POST', path, planned(), { Cookie: await env.login('chairman') })).status).toBe(201);
  });

  it('tracks a newly registered future item at its due boundary without another user request', async () => {
    const tomorrow = shiftDate(qualityDate(env.deps.clock()), 1);
    const response = await env.send('POST', '/api/modules/quality/complaints/CC-2610-09/capa', { ...planned(), due: tomorrow }, { Cookie: await env.login('quality') });
    const id = response.body.capa.id;
    expect(response.body.overdue).toBe(false);
    env.advance(2 * 24 * 60);
    evaluateDomain(env.deps, 'quality');
    expect(listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).some((e) => e.type === 'capa_overdue' && e.payload.capaId === id)).toBe(true);
  });
});

describe('8D step follow-ups and reference corrections', () => {
  it('answers D4 and D6 using the same complaint without repeating the whole report or inventing verification', async () => {
    const first = await ask('为CC-2610-09起草8D');
    const root = await ask('那D4呢？', first.conversation.id);
    expect(root.turn.result.artifacts[0].rows).toEqual([['D4 根因', '待失效分析']]);
    expect(root.turn.result.actions[0].title).toContain('CC-2610-09 完成失效分析');
    expect(root.turn.result.answer).toContain('冷启动时画面闪屏');
    const verify = await ask('D6如何验证？', first.conversation.id);
    expect(verify.turn.result.artifacts[0].rows).toHaveLength(1);
    expect(verify.turn.result.artifacts[0].rows[0][0]).toBe('D6 验证');
    expect(verify.turn.result.artifacts[0].rows[0][1]).toContain('实际结果待验证');
    expect(verify.turn.result.actions[0].title).toContain('收集实际结果');
  });

  it('resolves a clear correction or negated old ID without binding the old complaint', async () => {
    for (const question of ['不是CC-2610-05，是CC-2610-09，起草8D', 'CC-2610-05更正为CC-2610-09，D4呢', '不要CC-UNKNOWN，给CC-2610-09起草8D']) {
      const response = await ask(question);
      expect(response.turn.result.artifacts[0].title).toContain('CC-2610-09');
      expect(response.turn.result.artifacts[0].rows.some((r) => String(r[1]).includes('贴合压力'))).toBe(false);
      expect(response.turn.result.actions.every((a) => a.title.includes('CC-2610-09'))).toBe(true);
    }
  });

  it('does not treat repeated references to one ID as multiple complaints, but still rejects ambiguous two-ID requests', async () => {
    const repeated = await ask('为CC-2610-05起草8D，客诉编号CC-2610-05');
    expect(repeated.turn.result.artifacts[0].rows).toHaveLength(8);
    const ambiguous = await ask('给CC-2610-05和CC-2610-09起草8D');
    expect(ambiguous.turn.result.artifacts).toEqual([]);
  });

  it('does not revive the old complaint after the conversation switches to an unregistered problem', async () => {
    const first = await ask('为CC-2610-05起草8D');
    await ask('新的问题是外包装纸箱破损', first.conversation.id);
    const response = await ask('那D4呢', first.conversation.id);
    expect(response.turn.result.artifacts).toEqual([]);
    expect(response.turn.result.title).toContain('请先指定');
  });

  it('retains the complaint for a completion follow-up and separates unregistered work from completed work', async () => {
    const first = await ask('为CC-2610-09起草8D');
    const response = await ask('那整改完成了吗？', first.conversation.id);
    expect(response.turn.result.title).toContain('CC-2610-09');
    expect(response.turn.result.title).toContain('尚未建立');
    expect(response.turn.result.artifacts[0].rows).toEqual([]);
    expect(response.turn.result.pending.join(' ')).toContain('尚未建立整改台账');
  });

  it('grounds a corrected D4 follow-up in the new complaint even with an older 8D in conversation history', async () => {
    const first = await ask('为CC-2610-05起草8D');
    let latestContext = '';
    env.deps.provider = { mode: 'llm', model: 'test-provider', async complete(messages) {
      latestContext = messages.at(-1)!.content;
      return JSON.stringify({ title: '本次D4', answer: '本次根因待失效分析。' });
    } };
    const result = await ask('编号更正为CC-2610-09，D4呢', first.conversation.id);
    expect(latestContext).toContain('CC-2610-09');
    expect(latestContext).toContain('冷启动时画面闪屏');
    expect(latestContext).not.toContain('贴合压力参数');
    expect(result.turn.result.artifacts[0].rows).toEqual([['D4 根因', '待失效分析']]);
  });
});
