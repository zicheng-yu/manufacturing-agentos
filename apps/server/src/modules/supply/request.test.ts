import type { AgentResult, TableArtifact } from '@agentos/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { listTasks } from '../../core/memory.ts';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import { inheritPurchaseRequest, parsePurchaseRequest } from './request.ts';

const now = new Date('2026-10-30T09:00:00+08:00');

describe('explicit purchase request extraction', () => {
  it.each(['采购2000片FPC，三天内必须到', '买2,000片FPC，3天内到', '采购两千片FPC，交期最多三天', '采购2千片FPC，2026-11-02前到货'])('reads quantity and delivery date from %s', (input) => {
    const request = parsePurchaseRequest(input, now);
    expect(request.quantity).toEqual({ value: 2000, unit: '片' });
    expect(request.deadline?.date).toBe('2026-11-02');
    expect(request.errors).toEqual([]);
  });

  it('uses Shanghai calendar dates at midnight and over month boundaries', () => {
    const request = parsePurchaseRequest('需要2000片FPC，明天到', new Date('2026-10-30T16:30:00Z'));
    expect(request.deadline).toEqual({ date: '2026-11-01', days: 1, relative: true });
  });

  it('keeps payment terms and MOQ out of the request constraints', () => {
    const request = parsePurchaseRequest('采购2000片FPC，MOQ5000片，预付30%，月结60天', now);
    expect(request.quantity?.value).toBe(2000);
    expect(request.deadline).toBeUndefined();
    expect(request.deadlineSpecified).toBe(false);
    expect(request.errors).toEqual([]);
  });

  it.each(['采购0片FPC', '采购-5片FPC', '采购1.5片FPC', '采购2,00片FPC', '数量为2,00的FPC', '采购两三千片FPC', '采购2000片或3000片FPC', '采购两到三千片FPC', 'FPC追加1000片', '采购2000片FPC，2026-02-30到货', '采购2000片FPC，10月20日前到货', '采购2000片FPC，下周五到货', '采购2000片FPC，3个工作日内到货'])('requires clarification for %s', (input) => {
    expect(parsePurchaseRequest(input, now).errors.length).toBeGreaterThan(0);
  });

  it('accepts an explicit correction instead of treating it as two simultaneous quantities', () => {
    const request = parsePurchaseRequest('原来2000片，改为3000片FPC，11月3日前到货', now);
    expect(request.quantity?.value).toBe(3000);
    expect(request.deadline?.date).toBe('2026-11-03');
    expect(request.errors).toEqual([]);
  });

  it('inherits quantity and absolute dates but never silently restarts an older relative deadline', () => {
    const absolute = inheritPurchaseRequest('那改成3000片', ['采购2000片FPC，11月3日前到货'], now);
    expect(absolute.quantity?.value).toBe(3000);
    expect(absolute.deadline?.date).toBe('2026-11-03');
    const relative = inheritPurchaseRequest('那改成3000片', ['采购2000片FPC，三天内到'], now);
    expect(relative.quantity?.value).toBe(3000);
    expect(relative.deadline).toBeUndefined();
    expect(relative.pending.join(' ')).toContain('请确认本次最晚到货日期');
  });
});

describe('buyer request to quotation decision', () => {
  let env: TestEnv | undefined;
  afterEach(() => { env?.deps.db.close(); env = undefined; });
  async function ask(question: string, conversationId?: string) {
    env ??= setup(now);
    const cookie = await env.login('supply');
    const response = await env.send('POST', '/api/agents/supply.sourcing/turns', { question, conversationId }, { Cookie: cookie });
    expect(response.status).toBe(200);
    return response.body as { conversation: { id: string }; turn: { id: string; result: AgentResult } };
  }
  const table = (result: AgentResult): TableArtifact => result.artifacts.find((a) => a.title.endsWith('比价表'))!;

  it('uses the stated 2000 pieces, shows MOQ excess and does not call the fastest late quote feasible', async () => {
    const { turn } = await ask('需要2000片FPC，三天内必须到，哪家供应商合适？');
    expect(turn.result.title).toContain('暂无按期');
    const quotes = table(turn.result);
    const current = quotes.rows.find((r) => r[1] === '昆山精联电子')!;
    expect(current[5]).toBe(2000);
    expect(current[11]).toBe(0);
    const xc = quotes.rows.find((r) => r[1] === '无锡信创柔电')!;
    expect(xc[5]).toBe(5000);
    expect(xc[11]).toBe(3000);
    expect(xc[3]).toBe('19.10');
    expect(quotes.rows.every((r) => String(r[13]).startsWith('晚'))).toBe(true);
    expect(turn.result.actions.some((a) => a.title.includes('加急询价'))).toBe(true);
    expect(turn.result.actions.every((a) => !a.title.includes('下达'))).toBe(true);
    expect(listTasks(env!.deps.db, ['supply']).some((task) => task.title.includes('2000') && task.title.includes('2026-11-02'))).toBe(true);
  });

  it('chooses the lower total outlay among quotes meeting a relaxed deadline, rather than the lowest unit price', async () => {
    const { turn } = await ask('采购2000片FPC，十天内到货');
    const quotes = table(turn.result);
    expect(quotes.rows[0][1]).toBe('昆山精联电子');
    expect(quotes.rows[0][6]).toBe('3.72');
    expect(turn.result.answer).toContain('比指定数量多 0 片');
    expect(turn.result.pending.join(' ')).toContain('避免重复采购');
    expect(turn.result.answer).toContain('期限前预计到货 3000 片');
  });

  it('prioritises a quote that meets the deadline over a cheaper late quote', async () => {
    const { turn } = await ask('采购2000片FPC，五天内到货');
    const quotes = table(turn.result);
    expect(quotes.rows[0][1]).toBe('东莞德源电路');
    expect(quotes.rows[0][13]).toContain('可覆盖');
    expect(turn.result.pending.join(' ')).toContain('预付');
    expect(turn.result.pending.join(' ')).toContain('来料质量验证');
  });

  it('keeps the material and quantity through a deadline correction', async () => {
    const first = await ask('采购2000片FPC，三天内到货');
    const follow = await ask('那交期放宽到十天', first.conversation.id);
    expect(table(follow.turn.result).rows[0][1]).toBe('昆山精联电子');
    expect(table(follow.turn.result).rows[0][5]).toBe(2000);
    expect(follow.turn.result.answer).toContain('2026-11-09');
  });

  it('checks a named alternative using the same request and shows why it misses the deadline', async () => {
    const first = await ask('采购2000片FPC，11月4日前到货');
    const follow = await ask('换无锡信创行不行？', first.conversation.id);
    expect(follow.turn.result.answer).toContain('无锡信创柔电：采购 5000 片，多采 3000 片，含税总额 95485.00 元');
    expect(follow.turn.result.answer).toContain('无法覆盖本次期限，晚 5 天');
    const changed = await ask('那就买3000片，交期放宽到十天', first.conversation.id);
    expect(table(changed.turn.result).rows.every((r) => Number(r[5]) >= 3000)).toBe(true);
    expect(changed.turn.result.facts).toContain('本次明确比价量 3000 片');
  });

  it('does not carry an older material request onto a different material', async () => {
    const first = await ask('采购2000片FPC，十天内到货');
    const other = await ask('驱动芯片找哪家买最划算？', first.conversation.id);
    const quotes = table(other.turn.result);
    expect(quotes.title).toBe('DIC-0870 比价表');
    expect(quotes.rows.some((r) => r[5] === 2000)).toBe(false);
  });

  it('asks for quantities or unit conversion instead of inventing a purchase plan', async () => {
    for (const question of ['FPC三天内必须到', '采购2000箱FPC，三天内到货']) {
      const { turn } = await ask(question);
      expect(turn.result.artifacts.some((a) => a.title.endsWith('比价表'))).toBe(false);
      expect(turn.result.pending.length).toBeGreaterThan(0);
    }
  });

  it('makes the quantity and deadline part of an enquiry when the material has no quotations', async () => {
    const { turn } = await ask('采购2000片FPC-1025，11月3日前到货');
    expect(turn.result.title).toContain('暂无可比报价');
    expect(turn.result.actions[0].title).toContain('2000 片、2026-11-03前到货');
  });
});
