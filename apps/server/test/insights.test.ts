import { afterEach, describe, expect, it } from 'vitest';
import { officialFindings } from '../src/executive/insights.ts';
import { inventoryExposure } from '../src/modules/supply/evidence.ts';
import { warningTrigger, type Reading } from '../src/modules/production/data.ts';
import { listSignals } from '../src/core/signals.ts';
import { setup, type TestEnv } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(() => { env?.deps.db.close(); env = undefined; });
const official = () => env = setup(new Date('2026-10-30T09:00:00+08:00'), 'official');
const point = (ts: string, vibration = 3): Reading => ({ ts, vibration, equipmentId: 'EQ', temperature: null, current: null, rpm: null, load: null });

describe('platform-backed official evidence', () => {
  it('recomputes all findings and keeps record identifiers and uncertainty alongside results', () => {
    const e = official();
    const findings = officialFindings(e.deps.db, e.deps.clock());
    expect(findings).toHaveLength(7);
    expect(findings.every((f) => f.basis && f.boundary && f.table.note?.includes('官方仿真'))).toBe(true);
    expect(findings.find((f) => f.id === 'zero-output-energy')?.observation).toContain('2790.5 kWh');
    expect(findings.find((f) => f.id === 'aoi-high-confidence-escape')?.observation).toContain('11 条模型置信度≥0.9');
    expect(findings.find((f) => f.id === 'fatal-closure-gap')?.table.rows).toHaveLength(26);
    expect(inventoryExposure(e.deps.db).value).toBe(55969121.66);
    e.deps.db.prepare('UPDATE supply_materials SET on_hand = 0 WHERE stale_days >= 90').run();
    expect(inventoryExposure(e.deps.db).value).toBe(0);
    expect(officialFindings(e.deps.db, e.deps.clock()).find((f) => f.id === 'inventory-aging')?.table.rows).toEqual([]);
  });

  it('uses the third distinct reading in a 24h window, not the first warning or a duplicate', () => {
    const first = point('2026-10-01 00:00');
    const second = point('2026-10-01 01:00');
    const third = point('2026-10-01 02:00');
    expect(warningTrigger([first, first, second])).toBeNull();
    expect(warningTrigger([third, first, second])?.ts).toBe(third.ts);
    expect(warningTrigger([first, second, point('2026-10-02 02:00')])).toBeNull();
    expect(warningTrigger([first, second, point('2026-10-02 00:00')])?.ts).toBe('2026-10-02 00:00');
    expect(warningTrigger([first, second, point('2026-10-01 02:00', 2.7)])).toBeNull();
  });

  it('exposes the findings inside the platform to the chairman, with no automatic execution tasks', async () => {
    const e = official();
    const cookie = await e.login('chairman');
    const result = await e.send('POST', '/api/agents/executive.insights/turns', { question: '平台数据还有哪些发现？' }, { Cookie: cookie });
    expect(result.status).toBe(200);
    expect(result.body.turn.result.discoveries).toHaveLength(17);
    expect(result.body.turn.result.discoveries.every((d: any) => d.evidence.columns.length)).toBe(true);
    expect(result.body.turn.result.actions).toEqual([]);
    expect(result.body.turn.result.answer).toContain('不代表实际已实现收益');
    const focus = await e.send('POST', '/api/agents/executive.insights/turns', { question: '核验预警明细' }, { Cookie: cookie });
    expect(focus.body.turn.result.discoveries.find((d: any) => d.id === 'equipment-warning').evidence.rows).toHaveLength(16);
    expect((await e.send('POST', '/api/agents/executive.insights/turns', { question: '查库存' }, { Cookie: await e.login('supply') })).status).toBe(403);
  });

  it('does not turn repeated or future sensor readings into a current precursor alert', async () => {
    const e = official();
    e.deps.db.prepare('DELETE FROM production_sensors').run();
    const reading = { equipmentId: 'EQ-CNC-001', ts: '2026-10-30T00:00:00Z', vibration: 3 };
    await e.bridge('/api/modules/production/readings', [reading, reading, reading]);
    expect(listSignals(e.deps, ['production']).filter((s) => s.ruleId === 'production-vibration')).toEqual([]);
    await e.bridge('/api/modules/production/readings', [{ ...reading, ts: '2026-10-31T00:00:00Z', vibration: 9 }]);
    expect(listSignals(e.deps, ['production']).filter((s) => s.ruleId === 'production-vibration')).toEqual([]);
    await e.bridge('/api/modules/production/readings', [{ ...reading, ts: '2026-10-29T23:00:00Z' }, { ...reading, ts: '2026-10-29T22:00:00Z' }]);
    expect(listSignals(e.deps, ['production']).filter((s) => s.ruleId === 'production-vibration')).toHaveLength(1);
  });

  it('hides official-only discoveries on the fictional demo dataset', async () => {
    env = setup();
    const result = await env.send('POST', '/api/agents/executive.insights/turns', { question: '平台数据还有哪些发现？' }, { Cookie: await env.login('chairman') });
    expect(result.status).toBe(404);
  });
});
