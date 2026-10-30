import type { AgentResult } from '@agentos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestEvent, listEvents } from '../../core/events.ts';
import { evaluateDomain, listSignals } from '../../core/signals.ts';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import { qualityDate, shiftDate } from './calendar.ts';
import { complaintTrend, listCapa, similarCases } from './data.ts';
import { syncOverdueEvents } from './tracking.ts';

let env: TestEnv;
beforeEach(() => { env = setup(); });
afterEach(() => { env.deps.db.close(); });

async function ask(question: string, agent = 'quality.complaint', conversationId?: string) {
  const cookie = await env.login('quality');
  const response = await env.send('POST', `/api/agents/${agent}/turns`, { question, conversationId }, { Cookie: cookie });
  expect(response.status).toBe(200);
  return response.body as { conversation: { id: string }; turn: { id: string; result: AgentResult } };
}

const overdueEvents = () => listEvents(env.deps, { domains: ['quality'], status: 'unresolved', limit: 500 }).filter((e) => e.type === 'capa_overdue');

describe('quality retrieval and attribution', () => {
  it.each([
    ['仪表屏起泡', 'QC-2025-011'], ['偏光片鼓包', 'QC-2025-011'],
    ['画面明暗不一', 'QC-2025-003'], ['屏幕一块亮一块暗', 'QC-2025-003'],
    ['触摸没反应', 'QC-2026-002'], ['点了没反应', 'QC-2026-002'],
    ['FPC金手指发黑氧化', 'QC-2024-017'], ['驱动IC静电击穿', 'QC-2025-020'],
  ])('finds %s using symptom evidence', (query, id) => {
    expect(similarCases(env.deps.db, query)[0]?.case.id).toBe(id);
  });

  it.each(['外包装纸箱破损', '门锁失灵', '不是起泡，是外壳划伤', '屏幕一闪一闪'])('does not manufacture a historical match for %s', (query) => {
    expect(similarCases(env.deps.db, query)).toEqual([]);
  });

  it('supports flash aliases when a relevant case actually exists, without inventing one in demo data', () => {
    env.deps.db.prepare("UPDATE quality_cases SET title = '冷启动显示闪屏', symptom = '画面闪屏', category = '显示闪屏', keywords = '闪屏' WHERE id = 'QC-2025-020'").run();
    expect(similarCases(env.deps.db, '冷启动一闪一闪')[0]?.case.id).toBe('QC-2025-020');
  });

  it('requires symptom evidence rather than a category label alone', () => {
    expect(similarCases(env.deps.db, '外包装破损', 'FPC 接触不良')).toEqual([]);
    expect(similarCases(env.deps.db, '', '偏光片气泡')).toEqual([]);
  });

  it('does not let an old bubble question contaminate a new topic, but retains clear follow-ups', async () => {
    const first = await ask('偏光片起泡以前怎么解决');
    const follow = await ask('那现在先怎么围堵？', 'quality.complaint', first.conversation.id);
    expect(follow.turn.result.artifacts[0].rows[0][0]).toBe('QC-2025-011');
    const other = await ask('外包装纸箱破损', 'quality.complaint', first.conversation.id);
    expect(other.turn.result.artifacts).toEqual([]);
    expect(other.turn.result.facts.join(' ')).not.toContain('QC-2025-011');
    const afterSwitch = await ask('那怎么处理？', 'quality.complaint', first.conversation.id);
    expect(afterSwitch.turn.result.artifacts).toEqual([]);
    const recent = await ask('客户最近反馈偏光片起泡，怎么处理');
    expect(recent.turn.result.artifacts[0].title).toBe('相似案例');
  });

  it('reads an exact historical ID and asks to verify unrecorded IDs', async () => {
    expect(similarCases(env.deps.db, 'QC-2025-011')[0]?.case.id).toBe('QC-2025-011');
    const unknown = await ask('QC-9999-999 起泡是什么根因');
    expect(unknown.turn.result.title).toContain('未收录');
    expect(unknown.turn.result.artifacts).toEqual([]);
  });

  it('does not raise recurrence for a generic black screen, an incompatible category, or an ID-only reference', () => {
    for (const [id, symptom, category] of [['GENERIC', '黑屏', 'FPC 接触不良'], ['CATEGORY', '包装气泡', '包装'], ['REFERENCE', '参考QC-2025-011', '偏光片气泡']]) {
      ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: id, symptom, category }, source: { channel: 'bridge' } });
    }
    expect(listEvents(env.deps, { domains: ['quality'] }).filter((e) => e.type === 'defect_recurrence')).toEqual([]);
  });

  it('retains provenance and marks historical root cause as unverified for the current complaint', () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'TRACE', symptom: 'FPC 金手指发黑氧化', category: 'FPC 接触不良', supplierId: 'SUP-XC', supplier: '无锡信创柔电' }, source: { channel: 'bridge' } });
    const recurrence = listEvents(env.deps, { domains: ['quality'] }).find((e) => e.type === 'defect_recurrence')!;
    expect(recurrence.payload.caseId).toBe('QC-2024-017');
    expect(recurrence.payload.complaintId).toBe('TRACE');
    expect(recurrence.payload.rootCauseStatus).toBe('historical_only_pending_verification');
    expect(recurrence.payload.supplierId).toBe('SUP-XC');
    expect(recurrence.summary).toContain('责任归属待失效分析确认');
  });
});

describe('8D complaint scope', () => {
  it('does not draft another complaint when the requested ID is unknown or missing', async () => {
    for (const question of ['为CC-NOT-RECORDED起草8D', '起草8D']) {
      const response = await ask(question, 'quality.capa');
      expect(response.turn.result.artifacts).toEqual([]);
      expect(response.turn.result.actions.every((a) => !a.title.includes('冻结'))).toBe(true);
    }
  });

  it('drafts D1–D8 with a hypothetical root cause and planned verification', async () => {
    const response = await ask('为CC-2610-05起草8D', 'quality.capa');
    const table = response.turn.result.artifacts[0];
    expect(table.rows).toHaveLength(8);
    expect(table.rows[3][1]).toContain('本次需独立失效分析');
    expect(table.rows[4][1]).toContain('仅在本次根因验证成立后');
    expect(table.rows[5][1]).toContain('实际结果待验证');
    expect(response.turn.result.actions.every((a) => a.title.includes('CC-2610-05'))).toBe(true);
  });

  it('keeps an unmatched flash complaint at root cause pending instead of borrowing another case', async () => {
    const response = await ask('为CC-2610-09起草8D', 'quality.capa');
    expect(response.turn.result.artifacts[0].rows[3][1]).toBe('待失效分析');
    expect(response.turn.result.facts.join(' ')).not.toContain('QC-2024-017');
  });

  it('scopes corrective-action queries to a specified complaint without drafting a report', async () => {
    const response = await ask('CC-2610-05的8D整改项有哪些逾期？', 'quality.capa');
    expect(response.turn.result.artifacts[0].title).toBe('8D 整改项');
    expect(response.turn.result.artifacts[0].rows.every((r) => r[1] === 'CC-2610-05')).toBe(true);
  });

  it('does not reopen a closed complaint with new containment tasks', async () => {
    const response = await ask('为CC-2609-21起草8D复盘草案', 'quality.capa');
    expect(response.turn.result.title).toContain('已结案复盘');
    expect(response.turn.result.actions).toEqual([]);
  });
});

describe('automatic corrective-action tracking', () => {
  it('creates startup overdue alerts from business records rather than prewritten seed events', () => {
    const events = overdueEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload.capaId).toBe('CAPA-031');
    expect(events[0].source.actor).toBe('8D 自动跟踪规则');
    expect(events[0].source.channel).toBe('agent');
  });

  it('raises a new overdue alert when the existing service tick crosses the due date without a chat request', () => {
    const today = qualityDate(env.deps.clock());
    env.deps.db.prepare('INSERT INTO quality_capa VALUES (?, ?, ?, ?, ?, ?)').run('CAPA-TODAY', 'CC-2610-05', '验证贴合参数', '工艺负责人', today, '进行中');
    expect(overdueEvents().some((e) => e.payload.capaId === 'CAPA-TODAY')).toBe(false);
    env.advance(24 * 60);
    evaluateDomain(env.deps, 'quality');
    const event = overdueEvents().find((e) => e.payload.capaId === 'CAPA-TODAY')!;
    expect(event.payload.due).toBe(today);
    expect(event.turnId).toBeNull();
    expect(listSignals(env.deps, ['quality']).some((s) => s.eventIds.includes(event.id))).toBe(true);
    syncOverdueEvents(env.deps);
    expect(overdueEvents().filter((e) => e.payload.capaId === 'CAPA-TODAY')).toHaveLength(1);
    expect(overdueEvents().find((e) => e.id === event.id)!.count).toBe(1);
  });

  it('resolves alerts on completion and recreates one only when an overdue item is reopened', async () => {
    const cookie = await env.login('quality');
    const path = '/api/modules/quality/capa/CAPA-031';
    const done = await env.send('PATCH', path, { status: '已完成' }, { Cookie: cookie });
    expect(done.status).toBe(200);
    expect(done.body.overdue).toBe(false);
    expect(overdueEvents().some((e) => e.payload.capaId === 'CAPA-031')).toBe(false);
    expect(listSignals(env.deps, ['quality']).some((s) => s.ruleId === 'quality-capa-overdue')).toBe(false);
    const reopened = await env.send('PATCH', path, { status: '进行中' }, { Cookie: cookie });
    expect(reopened.body.overdue).toBe(true);
    expect(overdueEvents().filter((e) => e.payload.capaId === 'CAPA-031')).toHaveLength(1);
  });

  it('clears an alert after extending the deadline and raises it at the new due boundary', async () => {
    const cookie = await env.login('quality');
    const tomorrow = shiftDate(qualityDate(env.deps.clock()), 1);
    const patched = await env.send('PATCH', '/api/modules/quality/capa/CAPA-031', { due: tomorrow, owner: '新负责人' }, { Cookie: cookie });
    expect(patched.status).toBe(200);
    expect(overdueEvents().some((e) => e.payload.capaId === 'CAPA-031')).toBe(false);
    env.advance(24 * 60);
    evaluateDomain(env.deps, 'quality');
    expect(overdueEvents().some((e) => e.payload.capaId === 'CAPA-031')).toBe(false);
    env.advance(24 * 60);
    evaluateDomain(env.deps, 'quality');
    expect(overdueEvents().find((e) => e.payload.capaId === 'CAPA-031')!.payload.owner).toBe('新负责人');
  });

  it('enforces permissions and rejects invalid updates without changing business records', async () => {
    const path = '/api/modules/quality/capa/CAPA-031';
    expect((await env.send('PATCH', path, { status: '已完成' })).status).toBe(401);
    expect((await env.send('PATCH', path, { status: '已完成' }, { Cookie: await env.login('supply') })).status).toBe(403);
    const cookie = await env.login('quality');
    for (const input of [{ due: '2026-02-30' }, { owner: ' ' }, { status: '随便' }, {}, { extra: true }]) {
      expect((await env.send('PATCH', path, input, { Cookie: cookie })).status).toBe(400);
    }
    expect((await env.send('PATCH', '/api/modules/quality/capa/UNKNOWN', { status: '已完成' }, { Cookie: cookie })).status).toBe(404);
    expect(listCapa(env.deps.db).find((c) => c.id === 'CAPA-031')!.status).toBe('进行中');
  });

  it('keeps alert state alive across the signal window without accumulating occurrences', () => {
    env.advance(15 * 24 * 60);
    evaluateDomain(env.deps, 'quality');
    expect(overdueEvents().filter((e) => e.payload.capaId === 'CAPA-031')).toHaveLength(1);
    expect(overdueEvents().find((e) => e.payload.capaId === 'CAPA-031')!.count).toBe(1);
    expect(listSignals(env.deps, ['quality']).some((s) => s.ruleId === 'quality-capa-overdue')).toBe(true);
  });

  it('uses the China calendar at midnight and excludes cancelled corrective actions', () => {
    env.deps.db.close();
    env = setup(new Date('2026-10-30T15:59:00Z'));
    env.deps.db.prepare('INSERT INTO quality_capa VALUES (?, ?, ?, ?, ?, ?)').run('CAPA-MIDNIGHT', 'CC-2610-05', '跨日验证', '品质经理', '2026-10-30', '进行中');
    env.deps.db.prepare('INSERT INTO quality_capa VALUES (?, ?, ?, ?, ?, ?)').run('CAPA-CANCELLED', 'CC-2610-05', '取消验证', '品质经理', '2026-10-20', '已取消');
    env.advance(2);
    evaluateDomain(env.deps, 'quality');
    expect(overdueEvents().some((e) => e.payload.capaId === 'CAPA-MIDNIGHT')).toBe(true);
    expect(overdueEvents().some((e) => e.payload.capaId === 'CAPA-CANCELLED')).toBe(false);
  });
});

describe('complaint trends', () => {
  it('uses two separate 7-day windows, excludes future/cancelled rows and fills zero days', () => {
    const today = qualityDate(env.deps.clock());
    const insert = env.deps.db.prepare('INSERT INTO quality_complaints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [id, offset, status] of [['START', -6, '处理中'], ['PREVIOUS', -7, '处理中'], ['FUTURE', 1, '处理中'], ['CANCELLED', 0, '已取消']] as const) {
      insert.run(id, '测试客户', '演示产品', '测试批次', '包装破损', '包装', '一般', status, shiftDate(today, offset), '品质经理', null);
    }
    const trend = complaintTrend(env.deps.db, today);
    expect(trend.current).toBe(2);
    expect(trend.previous).toBe(2);
    expect(trend.delta).toBe(0);
    expect(trend.daily).toHaveLength(7);
    expect(trend.daily.some((d) => d.count === 0)).toBe(true);
    expect(trend.daily.reduce((sum, d) => sum + d.count, 0)).toBe(trend.current);
  });

  it('counts a repeated report as one complaint and exposes actual trends in the module and assistant', async () => {
    for (let i = 0; i < 3; i++) {
      ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'REPEATED', symptom: '包装破损', category: '包装' }, source: { channel: 'bridge' } });
      env.advance(11);
    }
    expect(complaintTrend(env.deps.db, qualityDate(env.deps.clock())).current).toBe(2);
    expect(listSignals(env.deps, ['quality']).some((s) => s.ruleId === 'quality-complaints')).toBe(false);
    const response = await ask('最近客诉趋势怎么样');
    expect(response.turn.result.artifacts[0].rows).toHaveLength(7);
    const cookie = await env.login('quality');
    const overview = await env.get('/api/modules/quality/overview', cookie);
    expect(overview.body.tables.some((t: { title: string }) => t.title === '近 7 天客诉趋势')).toBe(true);
  });
});

describe('quality model context and fallback', () => {
  it('preserves the selected complaint and pending root cause in model context and structured results', async () => {
    let context = '';
    env.deps.provider = { mode: 'llm', model: 'test-provider', async complete(messages) {
      context = messages.at(-1)!.content;
      return JSON.stringify({ title: '8D草案', answer: '先收集样品，根因待失效分析。' });
    } };
    const result = await ask('为CC-2610-09起草8D', 'quality.capa');
    expect(context).toContain('D4 根因：待失效分析');
    expect(context).not.toContain('QC-2024-017');
    expect(result.turn.result.artifacts[0].rows[3][1]).toBe('待失效分析');
  });

  it('falls back to the same scoped 8D when the provider fails', async () => {
    env.deps.provider = { mode: 'llm', model: 'test-provider', async complete() { throw new Error('test timeout'); } };
    const result = await ask('为CC-2610-05起草8D', 'quality.capa');
    expect(result.turn.result.artifacts[0].title).toBe('CC-2610-05 8D 报告草案');
    expect(result.turn.result.pending.join(' ')).toContain('已按规则分析作答');
  });
});
