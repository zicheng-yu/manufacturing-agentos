// YOU-143: a collaboration case must survive reloads, keep each department's data to itself, and never mistake
// "done" for "verified".
import { OFFICIAL_STORYLINE, stepBody } from '../src/seed/storyline.ts';
import { describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.ts';

const official = () => setup(new Date('2026-10-30T09:00:00+08:00'), 'official');

async function replay(env: TestEnv) {
  for (const step of OFFICIAL_STORYLINE) {
    expect((await env.bridge(step.path, stepBody(step, env.deps.clock()))).status, step.label).toBe(200);
    env.advance(0.5);
  }
}

async function ensureStockoutSignal(env: TestEnv, cookie: string) {
  const signals = (await env.get('/api/signals', cookie)).body as { id: string; domain: string; title: string; ruleId: string }[];
  const signal = signals.find((s) => s.ruleId === 'supply-stockout' && s.title.includes('线束03'));
  expect(signal, `线束03 缺料信号；当前信号：${signals.map((s) => `${s.id}|${s.title}`).join(' ; ')}`).toBeTruthy();
  return signal!;
}

const post = (env: TestEnv, cookie: string, path: string, body: unknown) => env.send('POST', path, body, { Cookie: cookie });

describe('collaboration cases', () => {
  it('opens one case per source, keeps the cause tag as a lead and never merges by material alone', async () => {
    const env = official();
    try {
      await replay(env);
      const cookie = await env.login('chairman');
      const signal = await ensureStockoutSignal(env, cookie);
      const first = await post(env, cookie, '/api/cases', { signalId: signal.id });
      expect(first.status).toBe(201);
      const again = await post(env, cookie, '/api/cases', { signalId: signal.id });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect((await env.get('/api/cases', cookie)).body).toHaveLength(1);

      const detail = (await env.get(`/api/cases/${first.body.id}`, cookie)).body;
      expect(detail.summary.status).toBe('pending');
      expect(detail.summary.objects.some((o: any) => o.type === 'material' && o.id === 'M-10003')).toBe(true);
      // Candidates are leads with a stated basis, not part of the case until a person adds them.
      const agv = detail.candidates.find((c: any) => c.domain === 'logistics');
      expect(agv.added).toBe(false);
      expect(agv.basis.join(' ')).toMatch(/共同(物料|原因标签)/);
      expect(detail.entries.filter((e: any) => e.kind === 'evidence')).toHaveLength(1);
      const added = await post(env, cookie, `/api/cases/${first.body.id}/candidates`, { signalId: agv.signalId });
      expect(added.status).toBe(200);
      expect(added.body.entries.filter((e: any) => e.kind === 'evidence')).toHaveLength(2);
      expect((await post(env, cookie, `/api/cases/${first.body.id}/candidates`, { signalId: agv.signalId })).status).toBe(409);
      // A signal with no shared object or tag cannot be attached.
      const unrelated = ((await env.get('/api/signals', cookie)).body as any[]).find((s) => !detail.candidates.some((c: any) => c.signalId === s.id) && s.id !== signal.id);
      expect((await post(env, cookie, `/api/cases/${first.body.id}/candidates`, { signalId: unrelated.id })).status).toBe(404);
    } finally { env.deps.db.close(); }
  });

  it('lets another role take over without widening what it can see', async () => {
    const env = official();
    try {
      await replay(env);
      const chairman = await env.login('chairman');
      const supply = await env.login('supply');
      const quality = await env.login('quality');
      const hr = await env.login('hr');
      const signal = await ensureStockoutSignal(env, chairman);
      const { id } = (await post(env, chairman, '/api/cases', { signalId: signal.id })).body;

      // A department outside the case cannot open it, list it or learn that it exists.
      expect((await env.get(`/api/cases/${id}`, hr)).status).toBe(404);
      expect((await env.get('/api/cases', hr)).body).toEqual([]);
      expect((await post(env, hr, `/api/cases/${id}/ask`, { agentId: 'hr.org', question: '人员情况' })).status).toBe(404);
      // Supply owns the origin domain, so it sees the case; quality has no module in it yet.
      expect((await env.get(`/api/cases/${id}`, supply)).status).toBe(200);
      expect((await env.get(`/api/cases/${id}`, quality)).status).toBe(404);

      const asked = await post(env, supply, `/api/cases/${id}/ask`, { agentId: 'supply.sourcing', question: '线束快断货了，几家供应商怎么选？' });
      expect(asked.status).toBe(200);
      const analysis = asked.body.entries.find((e: any) => e.kind === 'analysis');
      expect(analysis.author.name).toBe('寻源比价助手');
      expect(analysis.artifacts.length).toBeGreaterThan(0);
      expect(analysis.data.askedBy).toBe('供应链经理');

      // Production joins by adding its own contribution; supply's detail must not then show production-only data it cannot read.
      const production = await env.login('production');
      expect((await env.get(`/api/cases/${id}`, production)).status).toBe(404);
      // A role cannot ask an assistant outside its modules, and the self-service assistant never joins a case.
      expect((await post(env, supply, `/api/cases/${id}/ask`, { agentId: 'quality.defects', question: '不良情况' })).status).toBe(403);
      expect((await post(env, chairman, `/api/cases/${id}/ask`, { agentId: 'hr.service', question: '年假有几天？' })).status).toBe(400);

      // Only the owner (or the chairman) manages the case.
      const handed = asked.body.entries.find((e: any) => e.kind === 'analysis');
      expect(asked.body.canManage).toBe(false);
      expect((await post(env, supply, `/api/cases/${id}/actions`, { fromEntryId: handed.id, actionIndex: 0 })).status).toBe(403);
    } finally { env.deps.db.close(); }
  });

  it('keeps "done" apart from "verified" and never rewrites earlier receipts', async () => {
    const env = official();
    try {
      await replay(env);
      const cookie = await env.login('chairman');
      const signal = await ensureStockoutSignal(env, cookie);
      const { id } = (await post(env, cookie, '/api/cases', { signalId: signal.id })).body;
      const base = `/api/cases/${id}`;

      expect((await post(env, cookie, `${base}/submit`, {})).status).toBe(409);
      const asked = await post(env, cookie, `${base}/ask`, { agentId: 'supply.sourcing', question: '线束快断货了，几家供应商怎么选？' });
      const analysis = asked.body.entries.find((e: any) => e.kind === 'analysis');
      expect(analysis.data.actions.length).toBeGreaterThan(0);

      const confirmed = await post(env, cookie, `${base}/actions`, { fromEntryId: analysis.id, actionIndex: 0 });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.summary.status).toBe('active');
      expect((await post(env, cookie, `${base}/actions`, { fromEntryId: analysis.id, actionIndex: 0 })).status).toBe(409);
      const action = confirmed.body.entries.find((e: any) => e.kind === 'action');
      expect(confirmed.body.tasks).toHaveLength(1);

      // An open disposition without a receipt blocks verification.
      expect((await post(env, cookie, `${base}/submit`, {})).status).toBe(409);
      const receipt = await post(env, cookie, `${base}/receipts`, { actionEntryId: action.id, note: '已向供应商发出紧急采购订单（模拟回执）', simulated: true });
      expect(receipt.status).toBe(200);
      expect(receipt.body.tasks[0].status).toBe('done');
      expect((await post(env, cookie, `${base}/receipts`, { actionEntryId: action.id, note: '重复回执', simulated: true })).status).toBe(409);
      // Receipt done: the case is still not verified, and verifying early is refused.
      expect(receipt.body.summary.status).toBe('active');
      expect((await post(env, cookie, `${base}/verify`, { mode: 'auto' })).status).toBe(409);

      const submitted = await post(env, cookie, `${base}/submit`, {});
      expect(submitted.body.summary.status).toBe('verifying');
      expect(submitted.body.canAutoVerify).toBe(true);

      // The pack's stock is unchanged by a receipt, so recomputing from business data must fail the check.
      const failed = await post(env, cookie, `${base}/verify`, { mode: 'auto' });
      expect(failed.status).toBe(200);
      expect(failed.body.summary.status).toBe('active');
      expect(failed.body.summary.round).toBe(2);
      const verdict = failed.body.entries.find((e: any) => e.kind === 'verification');
      expect(verdict.data.passed).toBe(false);
      expect(verdict.data.mode).toBe('auto');
      expect(verdict.body).toContain('不代表问题已消失');
      // Round-1 history is intact after the failure.
      expect(failed.body.entries.filter((e: any) => e.kind === 'receipt' && e.round === 1)).toHaveLength(1);
      expect(failed.body.entries.filter((e: any) => e.kind === 'action' && e.round === 1)).toHaveLength(1);

      // Manual verification must state a criterion and a source, and is labelled as not system-proven.
      const second = await post(env, cookie, `${base}/actions`, { title: '启用苏州精工科技以外的备选供应商并复核到货', domain: 'supply' });
      expect(second.status).toBe(200);
      const action2 = second.body.entries.filter((e: any) => e.kind === 'action').at(-1);
      await post(env, cookie, `${base}/receipts`, { actionEntryId: action2.id, note: '备选货源到货 3000 件（模拟回执）', simulated: true });
      await post(env, cookie, `${base}/submit`, {});
      expect((await post(env, cookie, `${base}/verify`, { mode: 'manual', passed: true, criterion: '到货', note: '' })).status).toBe(400);
      const passed = await post(env, cookie, `${base}/verify`, { mode: 'manual', passed: true, criterion: '线束03 可用天数回到安全天数以上', note: '仓库盘点单 2026-10-31，在库 3000 件' });
      expect(passed.body.summary.status).toBe('verified');
      const manual = passed.body.entries.filter((e: any) => e.kind === 'verification').at(-1);
      expect(manual.body).toContain('非系统自动证实');
      expect(passed.body.entries.filter((e: any) => e.kind === 'verification')).toHaveLength(2);
    } finally { env.deps.db.close(); }
  });

  it('flags a verified case for review when the same condition fires again, and keeps the verification', async () => {
    const env = official();
    try {
      await replay(env);
      const cookie = await env.login('chairman');
      const signal = await ensureStockoutSignal(env, cookie);
      const { id } = (await post(env, cookie, '/api/cases', { signalId: signal.id })).body;
      const base = `/api/cases/${id}`;
      await post(env, cookie, `${base}/actions`, { title: '加急现有在途订单并核实排产', domain: 'supply' });
      const action = (await env.get(base, cookie)).body.entries.find((e: any) => e.kind === 'action');
      await post(env, cookie, `${base}/receipts`, { actionEntryId: action.id, note: '已加急（模拟回执）', simulated: true });
      await post(env, cookie, `${base}/submit`, {});
      await post(env, cookie, `${base}/verify`, { mode: 'manual', passed: true, criterion: '到货确认', note: '采购单到货签收记录' });
      const verified = (await env.get(base, cookie)).body;
      expect(verified.summary.status).toBe('verified');
      expect(verified.summary.needsReview).toBe(false);
      expect(verified.canAutoVerify).toBe(false);

      // The shortage is reported again after the check: the case must say so instead of staying quietly "verified".
      env.advance(5);
      await env.bridge('/api/bridge/events', {
        domain: 'supply', type: 'stockout_risk', channel: 'replay', title: '线束03 缺料风险', summary: '仓库反馈线束03 再次缺料',
        payload: { materialCode: 'M-10003', materialName: '线束03', causes: ['缺料待料'] },
      });
      const flagged = (await env.get(base, cookie)).body;
      expect(flagged.summary.needsReview).toBe(true);
      expect(flagged.summary.status).toBe('verified');
      expect(flagged.entries.some((e: any) => e.title.includes('需复核'))).toBe(true);
      expect(flagged.entries.filter((e: any) => e.kind === 'verification')).toHaveLength(1);
      // The new event shows up as evidence under the same case; nothing opens a second case for it.
      expect(flagged.entries.some((e: any) => e.kind === 'evidence' && e.data.update === true)).toBe(true);
      expect((await env.get('/api/cases', cookie)).body).toHaveLength(1);

      // Reopening starts a new round and keeps round 1 in the history.
      const reopened = (await post(env, cookie, `${base}/reopen`, {})).body;
      expect(reopened.summary.status).toBe('active');
      expect(reopened.summary.round).toBe(2);
      expect(reopened.summary.needsReview).toBe(false);
      expect(reopened.entries.filter((e: any) => e.kind === 'verification' && e.round === 1)).toHaveLength(1);
      expect(reopened.entries.filter((e: any) => e.kind === 'receipt' && e.round === 1)).toHaveLength(1);
      // Round 1's receipt still counts, so the owner can ask for another check right away.
      expect((await post(env, cookie, `${base}/submit`, {})).body.summary.status).toBe('verifying');
    } finally { env.deps.db.close(); }
  });

  it('does not let a lesson, an assistant answer or a candidate carry another department\'s content to a reader', async () => {
    const env = official();
    try {
      await replay(env);
      const chairman = await env.login('chairman');
      const supply = await env.login('supply');
      const stock = await ensureStockoutSignal(env, chairman);
      const { id } = (await post(env, chairman, '/api/cases', { signalId: stock.id })).body;
      const base = `/api/cases/${id}`;

      // The chairman files a disposition owned by HR; supply cannot see it.
      await post(env, chairman, `${base}/actions`, { title: '启动供应链部离职交接专项面谈', domain: 'hr' });
      await post(env, chairman, `${base}/actions`, { title: '启用备选供应商并加急', domain: 'supply' });
      // The same wording twice is one disposition, not two.
      expect((await post(env, chairman, `${base}/actions`, { title: '启用备选供应商并加急', domain: 'supply' })).status).toBe(409);
      const entries = (await env.get(base, chairman)).body.entries.filter((e: any) => e.kind === 'action');
      expect(entries).toHaveLength(2);
      for (const a of entries) await post(env, chairman, `${base}/receipts`, { actionEntryId: a.id, note: '已完成（模拟回执）', simulated: true });
      await post(env, chairman, `${base}/submit`, {});
      await post(env, chairman, `${base}/verify`, { mode: 'manual', passed: true, criterion: '线束03 库存回到安全库存以上', note: '仓库盘点单显示在库 3000 件' });
      // Quoting the HR disposition in the free-text measure is refused: supply can read the card.
      await post(env, chairman, `${base}/lesson`, { conditions: '日耗稳定、备选供应商已验证', measure: '先启动供应链部离职交接专项面谈，再加急', conclusion: 'effective' });
      const card = (await env.get(base, supply)).body;
      expect(JSON.stringify(card)).not.toContain('离职交接');
      expect(card.lesson.measure).toBe('启用备选供应商并加急');
      expect(card.lesson.tags).toEqual([]);
      expect(card.hiddenEntries).toBeGreaterThan(0);

      // A case supply can open elsewhere is offered the card without HR's wording, tags or HR's asker text.
      // Supply has no part in a logistics-origin case, so it cannot even open one.
      const agvCase = (await post(env, chairman, '/api/cases', { signalId: ((await env.get('/api/signals', chairman)).body as any[]).find((s) => s.ruleId === 'logistics-agv-task').id })).body.id;
      expect((await env.get(`/api/cases/${agvCase}`, supply)).status).toBe(404);
      // A supply-origin case about the same material can be opened, and is offered the card without HR's wording or tags.
      const riskSignal = ((await env.get('/api/signals', chairman)).body as any[]).find((s) => s.ruleId === 'supply-supplier-risk');
      const other = (await post(env, chairman, '/api/cases', { signalId: riskSignal.id })).body.id;
      const offered = await env.get(`/api/cases/${other}`, supply);
      expect(offered.status).toBe(200);
      expect(JSON.stringify(offered.body)).not.toContain('离职交接');
      expect(offered.body.similarLessons.length).toBeGreaterThan(0);
      expect(offered.body.similarLessons.every((l: any) => l.tags.length === 0)).toBe(true);
    } finally { env.deps.db.close(); }
  });

  it('keeps what the chairman types and what other departments did out of a module assistant\'s stored answer', async () => {
    const env = official();
    try {
      await replay(env);
      const chairman = await env.login('chairman');
      const supply = await env.login('supply');
      const stock = await ensureStockoutSignal(env, chairman);
      const { id } = (await post(env, chairman, '/api/cases', { signalId: stock.id })).body;
      const base = `/api/cases/${id}`;
      await post(env, chairman, `${base}/actions`, { title: '启动供应链部离职交接专项面谈', domain: 'hr' });

      const secret = '董事长内部口径：下周评估是否更换主供应商';
      const asked = await post(env, chairman, `${base}/ask`, { agentId: 'supply.sourcing', question: `${secret}。线束快断货了，几家供应商怎么选？` });
      expect(asked.status).toBe(200);
      const seenBySupply = JSON.stringify((await env.get(base, supply)).body);
      expect(seenBySupply).not.toContain('内部口径');
      expect(seenBySupply).not.toContain('离职交接');
      const answered = (await env.get(base, supply)).body.entries.find((e: any) => e.kind === 'analysis');
      expect(answered.data.askedBy).toBe('董事长');
      expect(answered.data.question).toBeUndefined();
    } finally { env.deps.db.close(); }
  });

  it('briefs a module assistant with that module\'s part of the case only, but a cross-department assistant with the asker\'s whole view', async () => {
    const env = official();
    try {
      await replay(env);
      const prompts: string[] = [];
      // With a model configured the case background is sent in the prompt; capture it, answer with a minimal reply.
      env.deps.provider = { mode: 'llm', model: 'test-double', async complete(messages) { prompts.push(messages.map((m) => m.content).join('\n')); return JSON.stringify({ title: '测试', answer: '结论', facts: [], pending: [], suggestions: [], actions: [] }); } };
      const chairman = await env.login('chairman');
      const stock = await ensureStockoutSignal(env, chairman);
      const { id } = (await post(env, chairman, '/api/cases', { signalId: stock.id })).body;
      const base = `/api/cases/${id}`;
      await post(env, chairman, `${base}/actions`, { title: '启动供应链部离职交接专项面谈', domain: 'hr' });
      const receipt = (await env.get(base, chairman)).body.entries.find((e: any) => e.kind === 'action');
      await post(env, chairman, `${base}/receipts`, { actionEntryId: receipt.id, note: '面谈已安排（模拟回执）', simulated: true });

      await post(env, chairman, `${base}/ask`, { agentId: 'supply.sourcing', question: '线束快断货了，几家供应商怎么选？' });
      const forSupply = prompts.at(-1)!;
      expect(forSupply).toContain('协作事项背景');
      expect(forSupply).not.toContain('离职交接');
      expect(forSupply).not.toContain('面谈已安排');

      // The cross-department briefing assistant is stored under 'executive' (chairman only), so it may use everything.
      await post(env, chairman, `${base}/ask`, { agentId: 'executive.briefing', question: '今天最需要我决定的三件事是什么？' });
      expect(prompts.at(-1)!).toContain('离职交接');
    } finally { env.deps.db.close(); }
  });

  it('only offers a system re-check for a stock case, and a stock case still fails it while stock is short', async () => {
    const env = official();
    try {
      await replay(env);
      const chairman = await env.login('chairman');
      const signals = (await env.get('/api/signals', chairman)).body as any[];
      const agv = signals.find((s) => s.ruleId === 'logistics-agv-task');
      const caseId = (await post(env, chairman, '/api/cases', { signalId: agv.id })).body.id;
      const base = `/api/cases/${caseId}`;
      // The AGV case mentions M-10003 but is about delivery timeouts: stock turning normal would prove nothing.
      expect((await env.get(base, chairman)).body.summary.objects.some((o: any) => o.id === 'M-10003')).toBe(true);
      await post(env, chairman, `${base}/actions`, { title: '调整 AGV-02 路线避开拥堵路口', domain: 'logistics' });
      const action = (await env.get(base, chairman)).body.entries.find((e: any) => e.kind === 'action');
      await post(env, chairman, `${base}/receipts`, { actionEntryId: action.id, note: '路线已调整（模拟回执）', simulated: true });
      const submitted = await post(env, chairman, `${base}/submit`, {});
      expect(submitted.body.canAutoVerify).toBe(false);
      expect((await post(env, chairman, `${base}/verify`, { mode: 'auto' })).status).toBe(409);
      expect((await env.get(base, chairman)).body.summary.status).toBe('verifying');
    } finally { env.deps.db.close(); }
  });

  it('does not write to a case for someone who cannot open it, and blocks a lesson from a case flagged for review', async () => {
    const env = official();
    try {
      await replay(env);
      const chairman = await env.login('chairman');
      const hr = await env.login('hr');
      const stock = await ensureStockoutSignal(env, chairman);
      const { id } = (await post(env, chairman, '/api/cases', { signalId: stock.id })).body;
      const base = `/api/cases/${id}`;
      const count = () => Number((env.deps.db.prepare('SELECT COUNT(*) AS n FROM case_entries WHERE case_id = ?').get(id) as { n: number }).n);
      env.advance(2);
      await env.bridge('/api/bridge/events', { domain: 'supply', type: 'stockout_risk', channel: 'replay', title: '线束03 缺料风险', summary: '再次缺料', payload: { materialCode: 'M-10003', materialName: '线束03', causes: ['缺料待料'] } });
      const before = count();
      expect((await env.get(base, hr)).status).toBe(404);
      expect((await env.get('/api/cases', hr)).body).toEqual([]);
      expect(count()).toBe(before);

      await post(env, chairman, `${base}/actions`, { title: '加急现有在途订单', domain: 'supply' });
      const action = (await env.get(base, chairman)).body.entries.find((e: any) => e.kind === 'action');
      await post(env, chairman, `${base}/receipts`, { actionEntryId: action.id, note: '已加急（模拟回执）', simulated: true });
      await post(env, chairman, `${base}/submit`, {});
      await post(env, chairman, `${base}/verify`, { mode: 'manual', passed: true, criterion: '到货确认', note: '采购单到货签收记录' });
      env.advance(5);
      await env.bridge('/api/bridge/events', { domain: 'supply', type: 'stockout_risk', channel: 'replay', title: '线束03 缺料风险', summary: '又一次缺料', payload: { materialCode: 'M-10003', materialName: '线束03', causes: ['缺料待料'] } });
      expect((await post(env, chairman, `${base}/lesson`, { conditions: '日耗稳定', conclusion: 'effective' })).status).toBe(409);
      expect((await env.get(base, chairman)).body.summary.needsReview).toBe(true);
    } finally { env.deps.db.close(); }
  });

  it('saves a confirmed lesson, offers it only where the role may read it, and never lets it stand in for the check', async () => {
    const env = official();
    try {
      await replay(env);
      const chairman = await env.login('chairman');
      const logistics = await env.login('logistics');
      const signals = (await env.get('/api/signals', chairman)).body as any[];
      const stock = await ensureStockoutSignal(env, chairman);
      const agv = signals.find((s) => s.ruleId === 'logistics-agv-task');
      const ehs = signals.find((s) => s.ruleId === 'ehs-high-risk');
      expect(agv && ehs).toBeTruthy();

      const first = (await post(env, chairman, '/api/cases', { signalId: stock.id })).body.id;
      const base = `/api/cases/${first}`;
      // A lesson only comes from a verified case, and only with stated conditions.
      expect((await post(env, chairman, `${base}/lesson`, { conditions: '日耗稳定', conclusion: 'effective' })).status).toBe(409);
      await post(env, chairman, `${base}/actions`, { title: '启用备选供应商并加急', domain: 'supply' });
      const action = (await env.get(base, chairman)).body.entries.find((e: any) => e.kind === 'action');
      await post(env, chairman, `${base}/receipts`, { actionEntryId: action.id, note: '备选货源已到货（模拟回执）', simulated: true });
      await post(env, chairman, `${base}/submit`, {});
      await post(env, chairman, `${base}/verify`, { mode: 'manual', passed: true, criterion: '线束03 库存回到安全库存以上', note: '仓库盘点单显示在库 3000 件' });
      expect((await post(env, chairman, `${base}/lesson`, { conditions: '', conclusion: 'effective' })).status).toBe(400);
      const saved = await post(env, chairman, `${base}/lesson`, { conditions: '日耗稳定、备选供应商已完成来料验证', conclusion: 'effective' });
      expect(saved.status).toBe(200);
      expect(saved.body.lesson.verification.mode).toBe('manual');
      expect(saved.body.lesson.confirmedBy).toContain('董事长');
      expect(saved.body.lesson.result).toContain('人工核验');
      expect((await post(env, chairman, `${base}/lesson`, { conditions: '日耗稳定、备选供应商', conclusion: 'effective' })).status).toBe(409);

      // A later case about the same material is offered the lesson, with its conditions and source.
      const other = (await post(env, chairman, '/api/cases', { signalId: agv.id })).body.id;
      const detail = (await env.get(`/api/cases/${other}`, chairman)).body;
      const offered = detail.similarLessons.find((l: any) => l.sourceCaseId === first);
      expect(offered).toBeTruthy();
      expect(offered.conditions).toContain('备选供应商');
      // An unrelated case is offered nothing: a shared cause tag alone is too weak to suggest a lesson.
      const unrelated = (await post(env, chairman, '/api/cases', { signalId: ehs.id })).body.id;
      expect((await env.get(`/api/cases/${unrelated}`, chairman)).body.similarLessons).toEqual([]);

      // The logistics manager can open the AGV case, but the lesson belongs to supply: neither offered nor referable.
      const seen = await env.get(`/api/cases/${other}`, logistics);
      expect(seen.status).toBe(200);
      expect(seen.body.similarLessons).toEqual([]);
      expect((await post(env, logistics, `/api/cases/${other}/references`, { lessonId: offered.id })).status).toBe(404);

      const used = await post(env, chairman, `/api/cases/${other}/references`, { lessonId: offered.id });
      expect(used.status).toBe(200);
      const entry = used.body.entries.find((e: any) => e.kind === 'reference');
      expect(entry.body).toContain('适用条件');
      expect(entry.pending.join('')).toContain('不替代本次核查');
      // Referencing a lesson changes neither the status nor the evidence of the case it is attached to.
      expect(used.body.summary.status).toBe('pending');
      expect(used.body.entries.filter((e: any) => e.kind === 'verification')).toHaveLength(0);
      expect((await post(env, chairman, `/api/cases/${other}/references`, { lessonId: offered.id })).status).toBe(409);

      const prompts: string[] = [];
      env.deps.provider = { mode: 'llm', model: 'test-double', async complete(messages) {
        prompts.push(messages.map((m) => m.content).join('\n'));
        return JSON.stringify({ title: '经验核查', answer: '请核查适用条件', facts: [], pending: [], suggestions: [], actions: [] });
      } };
      const ask = (agentId: string) => post(env, chairman, `/api/cases/${other}/ask`, { agentId, question: '请结合已引用经验判断本事项下一步。' });
      expect((await ask('executive.briefing')).status).toBe(200);
      expect(prompts.at(-1)).toContain(offered.measure);
      expect(prompts.at(-1)).toContain(offered.conditions);
      expect(prompts.at(-1)).toContain('不能代替本次验证');
      expect((await ask('logistics.agv')).status).toBe(200);
      expect(prompts.at(-1)).not.toContain(offered.conditions);

      // No visit to the source case: a recurrence must invalidate recommendation, reference and prompt immediately.
      env.advance(5);
      await env.bridge('/api/bridge/events', { domain: 'supply', type: 'stockout_risk', channel: 'replay', title: '线束03 缺料风险', summary: '验证后再次报告缺料', payload: { materialCode: 'M-10003', materialName: '线束03', causes: ['缺料待料'] } });
      expect((await post(env, chairman, `/api/cases/${unrelated}/references`, { lessonId: offered.id })).status).toBe(409);
      const invalid = (await env.get(`/api/cases/${other}`, chairman)).body;
      expect(invalid.similarLessons.some((l: any) => l.id === offered.id)).toBe(false);
      expect(invalid.entries.find((e: any) => e.kind === 'reference').data.valid).toBe(false);
      expect((await ask('executive.briefing')).status).toBe(200);
      expect(prompts.at(-1)).not.toContain(offered.conditions);

      // A different measure in a later round gets its own lesson; the old verification never becomes valid again.
      await post(env, chairman, `${base}/reopen`, {});
      env.advance(1);
      const changed = await post(env, chairman, `${base}/actions`, { title: '更换供货渠道并重新验收', domain: 'supply' });
      const nextAction = changed.body.entries.filter((e: any) => e.kind === 'action').at(-1);
      await post(env, chairman, `${base}/receipts`, { actionEntryId: nextAction.id, note: '新渠道验收完成（模拟）', simulated: true });
      await post(env, chairman, `${base}/submit`, {});
      const reverified = await post(env, chairman, `${base}/verify`, { mode: 'manual', passed: true, criterion: '新供货渠道已验收', note: '新渠道模拟验收单' });
      expect(reverified.body.lesson).toBeNull();
      expect((await env.get(`/api/cases/${other}`, chairman)).body.similarLessons.some((l: any) => l.id === offered.id)).toBe(false);
      expect((await post(env, chairman, `/api/cases/${other}/references`, { lessonId: offered.id })).status).toBe(409);
      const replacement = await post(env, chairman, `${base}/lesson`, { conditions: '新渠道已通过验收', conclusion: 'effective' });
      expect(replacement.status).toBe(200);
      expect(replacement.body.lesson.id).not.toBe(offered.id);
      expect(replacement.body.lesson.verification.entryId).not.toBe(offered.verification.entryId);
      expect(replacement.body.lesson.verification.round).toBe(2);
      expect(replacement.body.lesson.measure).toBe(nextAction.title);
      expect((await post(env, chairman, `${base}/lesson`, { conditions: '新渠道已通过验收', conclusion: 'effective' })).status).toBe(409);
      const nextReference = await post(env, chairman, `/api/cases/${other}/references`, { lessonId: replacement.body.lesson.id });
      expect(nextReference.status).toBe(200);
      expect(nextReference.body.entries.filter((e: any) => e.kind === 'reference')).toHaveLength(2);
      expect(nextReference.body.entries.find((e: any) => e.data.lessonId === offered.id).data.valid).toBe(false);
      expect((await ask('executive.briefing')).status).toBe(200);
      expect(prompts.at(-1)).toContain('新渠道已通过验收');
      expect(prompts.at(-1)).not.toContain(offered.conditions);
    } finally { env.deps.db.close(); }
  });
});
