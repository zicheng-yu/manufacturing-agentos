import type { Catalog, Cockpit, Signal } from '@agentos/shared';
import { describe, expect, it } from 'vitest';
import { runTurn, deleteTurn } from '../src/core/agents/runtime.ts';
import { ingestEvent, redactEvent } from '../src/core/events.ts';
import { listMemory, listTasks } from '../src/core/memory.ts';
import { listSignals } from '../src/core/signals.ts';
import { STORYLINE, stepBody } from '../src/seed/storyline.ts';
import { setup } from './helpers.ts';

describe('accounts and permissions', () => {
  it('rejects a wrong password and accepts the demo password', async () => {
    const env = setup();
    const bad = await env.send('POST', '/api/auth/login', { username: 'chairman', password: 'nope' });
    expect(bad.status).toBe(401);
    const cookie = await env.login('chairman');
    const session = await env.get('/api/session', cookie);
    expect(session.body.account.role).toBe('executive');
    expect(session.body.domains).toEqual(['production', 'supply', 'quality', 'logistics', 'ehs', 'hr']);
  });

  it('requires a session', async () => {
    const env = setup();
    const res = await env.app.request('/api/cockpit');
    expect(res.status).toBe(401);
  });

  it('shows a manager only their own module', async () => {
    const env = setup();
    const cookie = await env.login('supply');
    const catalog = await env.get<Catalog>('/api/catalog', cookie);
    expect(catalog.body.modules.map((m) => m.id)).toEqual(['supply']);
    expect(catalog.body.agents.filter((a) => !a.companyService).every((a) => a.module === 'supply')).toBe(true);
    expect(catalog.body.agents.filter((a) => a.companyService).map((a) => a.id)).toEqual(['hr.service']);
    expect((await env.get('/api/modules/hr/overview', cookie)).status).toBe(403);
    expect((await env.get('/api/accounts', cookie)).status).toBe(403);
    const cockpit = await env.get<Cockpit>('/api/cockpit', cookie);
    expect(cockpit.body.situations.map((s) => s.domain)).toEqual(['supply']);
    expect(cockpit.body.events.every((e) => e.domain === 'supply')).toBe(true);
  });

  it('lets the chairman see every module', async () => {
    const env = setup();
    const cookie = await env.login('chairman');
    const cockpit = await env.get<Cockpit>('/api/cockpit', cookie);
    expect(cockpit.body.situations.map((s) => s.domain)).toEqual(['production', 'supply', 'quality', 'logistics', 'ehs', 'hr']);
    for (const id of ['production', 'supply', 'quality', 'logistics', 'ehs', 'hr']) {
      const overview = await env.get(`/api/modules/${id}/overview`, cookie);
      expect(overview.status).toBe(200);
      expect(overview.body.tables.length).toBeGreaterThan(0);
    }
  });

  it('hides private event fields from roles that are not allowed to see them', () => {
    const env = setup();
    const { event } = ingestEvent(env.deps, {
      domain: 'hr',
      type: 'attrition_risk',
      payload: { department: '供应链部', position: '采购工程师', employeeName: '陈某', reason: '外部 offer' },
      source: { channel: 'manual' },
    });
    expect(redactEvent(env.deps, event, 'supply_mgr').payload.employeeName).toBe('（无权查看）');
    expect(redactEvent(env.deps, event, 'executive').payload.employeeName).toBe('陈某');
    expect(redactEvent(env.deps, event, 'hr_mgr').payload.reason).toBe('外部 offer');
  });
});

describe('event bridge', () => {
  it('rejects requests without the bridge token', async () => {
    const env = setup();
    const res = await env.send('POST', '/api/bridge/events', { type: 'grasp_failed', station: '码垛-02' });
    expect(res.status).toBe(401);
  });

  it('rejects event types the module does not define', async () => {
    const env = setup();
    const res = await env.bridge('/api/bridge/events', { domain: 'logistics', type: 'teleported' });
    expect(res.status).toBe(400);
  });

  it('merges repeats, raises a signal at the threshold and clears it when the window passes', async () => {
    const env = setup();
    const send = () => env.bridge('/api/bridge/events', { type: 'grasp_failed', station: '码垛-02' });
    const first = await send();
    await send();
    expect(listSignals(env.deps, ['logistics'])).toHaveLength(0);
    const third = await send();
    expect(third.body.events[0].id).toBe(first.body.events[0].id);
    expect(third.body.events[0].count).toBe(3);

    const [signal] = listSignals(env.deps, ['logistics']);
    expect(signal.title).toBe('码垛-02 抓取连续失败');
    expect(signal.severity).toBe('critical');

    env.advance(61);
    await env.bridge('/api/bridge/events', { type: 'recognition_failed', station: '识别-01' });
    expect(listSignals(env.deps, ['logistics']).find((s) => s.id === signal.id)).toBeUndefined();
  });

  it('clears a signal when its events are resolved', async () => {
    const env = setup();
    const cookie = await env.login('logistics');
    const res = await env.bridge('/api/bridge/events', { type: 'grasp_failed', station: '码垛-01', count: 3 });
    expect(listSignals(env.deps, ['logistics'])).toHaveLength(1);
    const patched = await env.send('PATCH', `/api/events/${res.body.events[0].id}`, { status: 'resolved' }, { Cookie: cookie });
    expect(patched.status).toBe(200);
    expect(listSignals(env.deps, ['logistics'])).toHaveLength(0);
  });

  it('accepts station metrics and rejects unknown stations', async () => {
    const env = setup();
    const ok = await env.bridge('/api/modules/logistics/metrics', { station: '码垛-02', picks: 10, pickFailures: 2 });
    expect(ok.body.accepted).toBe(1);
    const bad = await env.bridge('/api/modules/logistics/metrics', { station: '码垛-99', picks: 1 });
    expect(bad.status).toBe(400);
  });
});

describe('module reactions', () => {
  it('turns a supplier delay into a stockout risk when cover drops below safety stock', async () => {
    const env = setup();
    await env.bridge('/api/bridge/events', {
      domain: 'supply',
      type: 'inbound_delay',
      payload: { orderId: 'PO-2611', materialCode: 'FPC-1203', delayDays: 3 },
    });
    const signals = listSignals(env.deps, ['supply']);
    expect(signals.map((s) => s.ruleId).sort()).toEqual(['supply-inbound-delays', 'supply-stockout']);
    const cookie = await env.login('supply');
    const cockpit = await env.get<Cockpit>('/api/cockpit', cookie);
    expect(cockpit.body.situations[0].level).toBe('alert');
  });

  it('links a new complaint to a historical case and raises a recurrence', async () => {
    const env = setup();
    await env.bridge('/api/bridge/events', {
      domain: 'quality',
      type: 'customer_complaint',
      payload: { complaintId: 'CC-TEST', customer: '测试客户', symptom: '间歇黑屏，FPC 金手指氧化', category: 'FPC 接触不良' },
    });
    const recurrence = listSignals(env.deps, ['quality']).find((s) => s.ruleId === 'quality-recurrence');
    expect(recurrence?.title).toBe('同类异常复发：FPC 接触不良');
    const row = env.deps.db.prepare(`SELECT case_id FROM quality_complaints WHERE id = 'CC-TEST'`).get() as { case_id: string };
    expect(row.case_id).toBe('QC-2024-017');
  });

  it('does not link a complaint with an unrelated symptom', async () => {
    const env = setup();
    await env.bridge('/api/bridge/events', {
      domain: 'quality',
      type: 'customer_complaint',
      payload: { complaintId: 'CC-OTHER', symptom: '外包装纸箱破损', category: '包装' },
    });
    expect(listSignals(env.deps, ['quality']).some((s) => s.ruleId === 'quality-recurrence')).toBe(false);
  });
});

describe('agents', () => {
  it('normalizes quotes and recommends the supplier that closes the gap fastest', async () => {
    const env = setup();
    await env.bridge('/api/bridge/events', {
      domain: 'supply',
      type: 'inbound_delay',
      payload: { orderId: 'PO-2611', materialCode: 'FPC-1203', delayDays: 3 },
    });
    const cookie = await env.login('chairman');
    const res = await env.send('POST', '/api/agents/supply.sourcing/turns', { question: 'FPC 有没有替代货源？' }, { Cookie: cookie });
    expect(res.status).toBe(200);
    const table = res.body.turn.result.artifacts[0];
    expect(table.title).toBe('FPC-1203 比价表');
    expect(table.rows[0][1]).toBe('东莞德源电路');
    expect(table.rows.find((r: string[]) => r[1] === '无锡信创柔电')[3]).toBe('19.10');
    expect(res.body.turn.result.pending.some((p: string) => p.includes('预付'))).toBe(true);
    expect(res.body.turn.mode).toBe('offline');
  });

  it('writes facts to shared memory and tasks, and deleting the turn removes them', async () => {
    const env = setup();
    await env.bridge('/api/bridge/events', {
      domain: 'supply',
      type: 'inbound_delay',
      payload: { orderId: 'PO-2611', materialCode: 'FPC-1203', delayDays: 3 },
    });
    const account = (await env.get('/api/session', await env.login('chairman'))).body.account;
    const { turn } = await runTurn(env.deps, { account, agentId: 'supply.inventory', question: '哪些物料快缺料了？' });
    const memory = listMemory(env.deps.db, ['supply']).filter((m) => m.turnId === turn.id);
    const tasks = listTasks(env.deps.db, ['supply']).filter((t) => t.turnId === turn.id);
    expect(memory.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    deleteTurn(env.deps, account, turn.id);
    expect(listMemory(env.deps.db, ['supply']).filter((m) => m.turnId === turn.id)).toHaveLength(0);
    expect(listTasks(env.deps.db, ['supply']).filter((t) => t.turnId === turn.id)).toHaveLength(0);
  });

  it('answers HR policy questions from the policy library and routes unknown ones to a person', async () => {
    const env = setup();
    const cookie = await env.login('hr');
    const known = await env.send('POST', '/api/agents/hr.service/turns', { question: '年假有几天' }, { Cookie: cookie });
    expect(known.body.turn.result.title).toContain('年休假');
    const unknown = await env.send('POST', '/api/agents/hr.service/turns', { question: '公司有班车吗' }, { Cookie: cookie });
    expect(unknown.body.turn.result.actions[0].owner).toBe('HR 经理');
  });

  it('refuses agents outside the account scope', async () => {
    const env = setup();
    const cookie = await env.login('quality');
    const res = await env.send('POST', '/api/agents/supply.sourcing/turns', { question: '比价' }, { Cookie: cookie });
    expect(res.status).toBe(403);
  });
});

describe('fixes from the demo case review', () => {
  it('keeps a re-observed condition as one event without inflating its count or summary', () => {
    const env = setup();
    const first = ingestEvent(env.deps, {
      domain: 'supply',
      type: 'stockout_risk',
      summary: 'PO-2611 延迟 3 天后可用 1.7 天',
      payload: { materialCode: 'FPC-1203' },
      source: { channel: 'bridge' },
    });
    env.advance(30);
    const again = ingestEvent(env.deps, {
      domain: 'supply',
      type: 'stockout_risk',
      summary: '可用 1.7 天',
      payload: { materialCode: 'FPC-1203' },
      source: { channel: 'agent' },
    });
    expect(again.event.id).toBe(first.event.id);
    expect(again.event.count).toBe(1);
    expect(again.event.summary).toBe('PO-2611 延迟 3 天后可用 1.7 天');
  });

  it('follows the material through a follow-up and says when a material is not in the catalogue', async () => {
    const env = setup();
    const cookie = await env.login('chairman');
    const ask = (question: string, conversationId?: string) =>
      env.send('POST', '/api/agents/supply.sourcing/turns', { question, conversationId }, { Cookie: cookie });
    const first = await ask('柔性板快断货了，几家供应商怎么选？');
    expect(first.body.turn.result.artifacts[0].title).toBe('FPC-1203 比价表');
    const followUp = await ask('东莞德源要预付 30%，换无锡信创行不行？', first.body.conversation.id);
    expect(followUp.body.turn.result.artifacts[0].title).toBe('FPC-1203 比价表');
    const unknown = await ask('MLCC 电容有没有更便宜的货源？');
    expect(unknown.body.turn.result.artifacts[0].title).toBe('合格供应商');
    const chips = await ask('驱动芯片找哪家买最划算？');
    expect(chips.body.turn.result.artifacts[0].title).toBe('DIC-0870 比价表');
    // Driver ICs are not short once the delayed order is counted, so no purchase is pushed.
    expect(chips.body.turn.result.actions).toHaveLength(0);
  });

  it('finds quality cases from plain words and keeps corrective-action questions off the 8D', async () => {
    const env = setup();
    const cookie = await env.login('quality');
    const blister = await env.send('POST', '/api/agents/quality.complaint/turns', { question: '仪表屏边上起泡了，以前怎么处理' }, { Cookie: cookie });
    expect(blister.body.turn.result.artifacts[0].rows[0][0]).toBe('QC-2025-011');
    const overdue = await env.send('POST', '/api/agents/quality.capa/turns', { question: '哪些整改项逾期了？' }, { Cookie: cookie });
    expect(overdue.body.turn.result.artifacts[0].title).toBe('8D 整改项');
  });

  it('answers HR follow-ups from the earlier question and routes uncovered ones to a person', async () => {
    const env = setup();
    const cookie = await env.login('hr');
    const first = await env.send('POST', '/api/agents/hr.service/turns', { question: '年假有几天' }, { Cookie: cookie });
    const followUp = await env.send(
      'POST',
      '/api/agents/hr.service/turns',
      { question: '我入职 3 年了呢', conversationId: first.body.conversation.id },
      { Cookie: cookie },
    );
    expect(followUp.body.turn.result.title).toContain('年休假');
    const proof = await env.send('POST', '/api/agents/hr.service/turns', { question: '需要开具收入证明用于房贷' }, { Cookie: cookie });
    expect(proof.body.turn.result.actions[0].owner).toBe('HR 经理');
  });
});

describe('demo storyline', () => {
  it('ripples from one station into a chairman briefing across all four modules', async () => {
    const env = setup();
    for (const step of STORYLINE) {
      const res = await env.bridge(step.path, stepBody(step, env.deps.clock()));
      expect(res.status, step.label).toBe(200);
      env.advance(0.5);
    }
    const cookie = await env.login('chairman');
    const cockpit = await env.get<Cockpit>('/api/cockpit', cookie);
    const levels = Object.fromEntries(cockpit.body.situations.map((s) => [s.domain, s.level]));
    // The fictional fixtures have no production or EHS data, so those cards stay normal.
    expect(levels).toEqual({ production: 'normal', supply: 'alert', quality: 'alert', logistics: 'alert', ehs: 'normal', hr: 'alert' });

    const briefing = await env.send('POST', '/api/cockpit/briefing', {}, { Cookie: cookie });
    expect(briefing.status).toBe(200);
    const result = briefing.body.turn.result;
    expect(result.artifacts[0].rows).toHaveLength(3);
    // Business-level decisions lead; the station fault is a supervisor's call.
    expect(result.artifacts[0].rows[0][5]).toContain('FPC');
    expect(result.artifacts[0].rows.some((r: string[]) => r[5].includes('码垛-02'))).toBe(false);
    const fpc = result.facts.find((f: string) => f.startsWith('FPC-1203：'));
    expect(fpc).toContain('智能物流「入库暂存区积压 46 箱」');
    expect(fpc).toContain('品质「');
    expect(result.facts.some((f: string) => f.includes('可用 1.7 天'))).toBe(true);
    expect(result.facts.some((f: string) => f.includes('供应链部减员预警与供应链风险叠加'))).toBe(true);

    const after = await env.get<Cockpit>('/api/cockpit', cookie);
    expect(after.body.briefing?.id).toBe(briefing.body.turn.id);
    expect(after.body.tasks.length).toBeGreaterThanOrEqual(3);
    const signals: Signal[] = after.body.signals;
    expect(signals.filter((s) => s.severity === 'critical')).toHaveLength(4);
  });
});
