import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.ts';
import { listMemory } from '../src/core/memory.ts';
import { equipmentHealth } from '../src/modules/production/data.ts';

let env: TestEnv;
beforeEach(() => { env = setup(new Date('2026-10-31T09:00:00+08:00'), 'official'); });
afterEach(() => env.deps.db.close());
const ask = async (agent: string, question: string, extra = {}, user = 'chairman') => env.send('POST', `/api/agents/${agent}/turns`, { question, ...extra }, { Cookie: await env.login(user) });

describe('discoveries and explicit working-memory handoff', () => {
  it('exposes database-backed observations, backtests and scenarios with evidence instead of invented improvements', async () => {
    const r = await ask('executive.discoveries', '还有哪些值得行动的数据发现');
    expect(r.status).toBe(200);
    const findings = r.body.turn.result.discoveries;
    expect(findings.length).toBeGreaterThanOrEqual(12);
    expect(findings.every((d: any) => d.source && d.scope && d.limitation && d.evidence.columns.length)).toBe(true);
    expect(findings.find((d: any) => d.id === 'agv-ceiling').summary).toContain('90.7%');
    expect(findings.find((d: any) => d.id === 'aoi-holdout').summary).toContain('不能声称');
    expect((await ask('executive.discoveries', '全部发现', {}, 'supply')).status).toBe(403);
  });

  it('dates warnings from the third qualifying reading, with no future readings used at the trigger', () => {
    env.deps.db.exec('DELETE FROM production_sensors; DELETE FROM production_repairs;');
    const insert = env.deps.db.prepare('INSERT INTO production_sensors (equipment_id, ts, vibration) VALUES (?, ?, ?)');
    for (const [time, vibration] of [['01:00', 3], ['02:00', 3], ['03:00', 3], ['04:00', 1]] as const) insert.run('EQ-CNC-001', `2026-09-10 ${time}`, vibration);
    env.deps.db.prepare('INSERT INTO production_repairs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('REVIEW-WO', 'EQ-CNC-001', '2026-09-10 05:00', 'test', 'pending', 10, 100, 1, 'inspect');
    const lead = equipmentHealth(env.deps.db).find(h => h.equipment.id === 'EQ-CNC-001')!.precursors[0];
    expect(lead.firstWarning).toBe('2026-09-10 03:00');
    expect(lead.hoursAhead).toBe(2);
  });

  it('refreshes selected discoveries during handoff, checks ownership and stops quoting deleted sources', async () => {
    const source = await ask('executive.discoveries', 'AGV 配送还有什么发现');
    const extra = { sourceTurnId: source.body.turn.id, sourceFindingId: 'agv-ceiling' };
    expect((await ask('logistics.agv', '继续分析', extra, 'logistics')).status).toBe(404);
    env.deps.db.exec('UPDATE logistics_agv_tasks SET timeout = 0');
    const next = await ask('logistics.agv', '重新分析按时率', extra);
    expect(next.status).toBe(200);
    expect(next.body.turn.result.reference.summary).toContain('当前 100%');
    expect(next.body.turn.result.reference.refreshedAt).toBeTruthy();
    await env.send('DELETE', `/api/turns/${source.body.turn.id}`, undefined, { Cookie: await env.login('chairman') });
    const follow = await ask('logistics.agv', '继续分析', { conversationId: next.body.conversation.id });
    expect(follow.body.turn.result.reference).toBeUndefined();
    expect(follow.body.turn.result.pending.join(' ')).toContain('来源已过期、删除或不可访问');
  });

  it('keeps independent conversation provenance and never persists model-only facts or actions', async () => {
    const a = await ask('production.equipment', '预警能提前多久');
    const b = await ask('production.equipment', '预警能提前多久');
    expect(listMemory(env.deps.db, ['production']).some(m => m.turnId === a.body.turn.id)).toBe(true);
    expect(listMemory(env.deps.db, ['production']).some(m => m.turnId === b.body.turn.id)).toBe(true);
    await env.send('DELETE', `/api/turns/${a.body.turn.id}`, undefined, { Cookie: await env.login('chairman') });
    expect(listMemory(env.deps.db, ['production']).some(m => m.turnId === b.body.turn.id)).toBe(true);
    const agent = env.deps.registry.agent('production.equipment'), original = agent.context;
    try {
      agent.context = () => ({ blocks: [], facts: [], actions: [] });
      env.deps.provider = { mode: 'llm', model: 'test', async complete() { return JSON.stringify({ answer: '无法确认', facts: ['虚构收益100万元'], actions: [{ title: '未经确认自动采购' }] }); } };
      const r = await ask('production.equipment', '没有数据时呢');
      expect(r.body.turn.result.facts).toEqual([]);
      expect(r.body.turn.result.actions).toEqual([]);
      expect(listMemory(env.deps.db, ['production']).some(m => m.content.includes('虚构收益'))).toBe(false);
    } finally { agent.context = original; }
  });
});
