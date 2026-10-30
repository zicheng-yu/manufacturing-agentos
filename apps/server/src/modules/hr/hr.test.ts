import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import { listTasks } from '../../core/memory.ts';
import { getEvent, ingestEvent, setEventStatus } from '../../core/events.ts';
import { listSignals } from '../../core/signals.ts';
import { migrate } from '../../db.ts';
import { listPositions, lookupPolicies } from './data.ts';
import { hrModule } from './index.ts';
import { POLICY_EVALUATION } from './policy-evaluation.ts';
import { listRequests, serviceRequestEvent } from './requests.ts';
import { jobDescription, screenCandidates, trainingPlan } from './talent.ts';

describe('HR policy evaluation · 30 questions', () => {
  let env: TestEnv;
  beforeAll(() => { env = setup(); });
  afterAll(() => env.deps.db.close());
  it.each(POLICY_EVALUATION)('$question', ({ question, history, ids, handoff }) => {
    const result = lookupPolicies(env.deps.db, question, history);
    expect(result.hits.map((h) => h.policy.id).sort()).toEqual([...ids].sort());
    expect(result.gaps.length > 0).toBe(handoff);
  });
});

describe('HR service workflow', () => {
  let env: TestEnv;
  let cookie: string;
  beforeEach(async () => { env = setup(); cookie = await env.login('hr'); });
  afterEach(() => env.deps.db.close());
  const ask = (question: string, conversationId?: string) => env.send('POST', '/api/agents/hr.service/turns', { question, conversationId }, { Cookie: cookie });

  it('preserves the policy source and persists only questions needing human service', async () => {
    const known = await ask('年假有几天？');
    expect(known.body.turn.result.facts[0]).toContain('P-01《年休假》');
    expect(known.body.turn.result.eventIds).toHaveLength(0);
    expect(listRequests(env.deps.db)).toHaveLength(2);
    const unknown = await ask('公司有班车吗？', known.body.conversation.id);
    expect(unknown.body.turn.result.facts).toHaveLength(0);
    expect(unknown.body.turn.result.eventIds).toHaveLength(1);
    const request = listRequests(env.deps.db).find((r) => r.question === '公司有班车吗？')!;
    expect(request.status).toBe('待处理');
    expect(request.eventId).toBe(unknown.body.turn.result.eventIds[0]);
    const overview = await env.get('/api/modules/hr/overview', cookie);
    expect(overview.body.metrics.find((m: { label: string }) => m.label === '未解决员工请求').value).toBe(3);
  });

  it('does not revive a policy across topic changes or use broad pronouns to guess a topic', () => {
    for (const question of ['上限多少？', '这个健身房什么时候开放？']) {
      const result = lookupPolicies(env.deps.db, question, ['年假有几天？', '公司有班车吗？']);
      expect(result.hits).toHaveLength(0);
      expect(result.gaps.length).toBeGreaterThan(0);
    }
  });

  it('keeps covered facts while handing off the uncovered part of a mixed question', async () => {
    const result = await ask('年假有几天，还有班车吗？');
    expect(result.body.turn.result.facts[0]).toContain('P-01');
    expect(result.body.turn.result.pending.join()).toContain('班车');
    expect(listRequests(env.deps.db)).toHaveLength(3);
  });

  it('does not mistake a matching policy topic for coverage of a missing procedure', () => {
    for (const question of ['公积金怎么提取？', '社保断缴怎么补缴？', '年假没休完可以折现吗？', '国外出差报销标准？', '培训考试没通过能报销吗？']) {
      const result = lookupPolicies(env.deps.db, question);
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.gaps.length).toBeGreaterThan(0);
    }
  });

  it('deduplicates repeated questions and tasks per account, including punctuation changes', async () => {
    const first = await ask('公司有班车吗？');
    env.advance(20);
    const second = await ask('公司有班车吗');
    expect(second.body.turn.result.eventIds).toEqual(first.body.turn.result.eventIds);
    expect(getEvent(env.deps, first.body.turn.result.eventIds[0])?.count).toBe(1);
    expect(listRequests(env.deps.db)).toHaveLength(3);
    expect(listTasks(env.deps.db, ['hr'])).toHaveLength(1);
    const chairman = await env.login('chairman');
    await env.send('POST', '/api/agents/hr.service/turns', { question: '公司有班车吗？' }, { Cookie: chairman });
    expect(listRequests(env.deps.db)).toHaveLength(4);
  });

  it('acknowledges, answers and resolves a request together with its event and task', async () => {
    const result = await ask('公司有班车吗？');
    const eventId = result.body.turn.result.eventIds[0];
    setEventStatus(env.deps, eventId, 'acknowledged');
    const request = listRequests(env.deps.db).find((r) => r.eventId === eventId)!;
    expect(request.status).toBe('处理中');
    const empty = await env.send('PATCH', '/api/modules/hr/requests/' + request.id, { status: '已解决' }, { Cookie: cookie });
    expect(empty.status).toBe(400);
    const resolved = await env.send('PATCH', '/api/modules/hr/requests/' + request.id, { status: '已解决', answer: '已核实，请查收 HR 提供的演示交通安排。' }, { Cookie: cookie });
    expect(resolved.status).toBe(200);
    expect(resolved.body.answer).toContain('已核实');
    expect(resolved.body.handledBy).toBeTruthy();
    expect(getEvent(env.deps, eventId)?.status).toBe('resolved');
    expect(listTasks(env.deps.db, ['hr'], 'done')).toHaveLength(1);
    const reopened = await env.send('PATCH', '/api/modules/hr/requests/' + request.id, { status: '待处理' }, { Cookie: cookie });
    expect(reopened.status).toBe(200);
    expect(getEvent(env.deps, eventId)?.status).toBe('open');
    expect(listTasks(env.deps.db, ['hr'])).toHaveLength(1);
  });

  it('allows a new service request after the earlier one has been resolved', async () => {
    const first = await ask('公司有班车吗？');
    setEventStatus(env.deps, first.body.turn.result.eventIds[0], 'resolved');
    const second = await ask('公司有班车吗？');
    expect(second.body.turn.result.eventIds).not.toEqual(first.body.turn.result.eventIds);
    expect(listRequests(env.deps.db)).toHaveLength(4);
    expect(listTasks(env.deps.db, ['hr'])).toHaveLength(1);
    expect(listTasks(env.deps.db, ['hr'], 'done')).toHaveLength(1);
  });

  it('removes an agent-created request when its originating turn is deleted', async () => {
    const result = await ask('需要收入证明用于房贷');
    const deleted = await env.send('DELETE', '/api/turns/' + result.body.turn.id, undefined, { Cookie: cookie });
    expect(deleted.status).toBe(200);
    expect(listRequests(env.deps.db)).toHaveLength(2);
    expect(listTasks(env.deps.db, ['hr'], 'all')).toHaveLength(0);
  });

  it('raises a traceable service backlog signal at five distinct requests and clears it after resolution', async () => {
    const ids: string[] = [];
    for (const question of ['公司有班车吗', '宿舍怎么申请', '如何办理落户', '个税在哪里查', '收入证明怎么办']) {
      const result = await ask(question);
      ids.push(result.body.turn.result.eventIds[0]);
    }
    const signal = listSignals(env.deps, ['hr']).find((s) => s.ruleId === 'hr-service-requests')!;
    expect(signal.count).toBe(5);
    expect(signal.eventIds.sort()).toEqual([...ids].sort());
    const detail = await env.get('/api/signals/' + signal.id, cookie);
    expect(detail.body.events).toHaveLength(5);
    setEventStatus(env.deps, ids[0], 'resolved');
    expect(listSignals(env.deps, ['hr']).some((s) => s.ruleId === 'hr-service-requests')).toBe(false);
  });

  it('adds its schema idempotently without resetting legacy requests', async () => {
    migrate(env.deps.db, [hrModule.schema!]);
    migrate(env.deps.db, [hrModule.schema!]);
    expect(listRequests(env.deps.db)).toHaveLength(2);
    const updated = await env.send('PATCH', '/api/modules/hr/requests/REQ-301', { status: '已解决', answer: '演示答复：请联系 HR 获取备案材料。' }, { Cookie: cookie });
    expect(updated.status).toBe(200);
    expect(updated.body.eventId).toBeNull();
    expect(listRequests(env.deps.db)).toHaveLength(2);
  });

  it('does not expose HR APIs or agents to another department or anonymous callers', async () => {
    const other = await env.login('quality');
    for (const path of ['/api/modules/hr/requests', '/api/modules/hr/roles', '/api/modules/hr/roles/POS-01/jd']) {
      expect((await env.get(path, '')).status).toBe(401);
      expect((await env.get(path, other)).status).toBe(403);
    }
    for (const path of ['/api/modules/hr/screening', '/api/modules/hr/training-plan', '/api/agents/hr.recruitment/turns', '/api/agents/hr.training/turns']) {
      expect((await env.send('POST', path, { question: '测试' }, { Cookie: other })).status).toBe(403);
    }
    expect((await env.send('PATCH', '/api/modules/hr/requests/REQ-301', { status: '处理中' }, { Cookie: other })).status).toBe(403);
    expect((await env.send('PATCH', '/api/modules/hr/requests/missing', { status: '处理中' }, { Cookie: cookie })).status).toBe(404);
    expect((await env.send('PATCH', '/api/modules/hr/requests/REQ-301', { status: '错误状态' }, { Cookie: cookie })).status).toBe(400);
  });
});

describe('HR recruitment and training', () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => env.deps.db.close());
  const full = [
    { name: '供应商管理', level: 2 }, { name: '成本分析', level: 2 }, { name: 'ERP', level: 2 },
  ];

  it('drafts a grounded JD and leaves unknown commercial terms pending', () => {
    const result = jobDescription(env.deps.db, 'POS-01');
    expect(result.blocks[1].lines).toContain('执行寻源与询价，核对价格、交期及付款条件');
    expect(result.pending?.join()).toContain('薪酬范围');
    expect(jobDescription(env.deps.db, 'POS-999').headline).toContain('请指定');
  });

  it('scores evidence without changing candidate order or recruitment state', () => {
    const before = listPositions(env.deps.db);
    const result = screenCandidates(env.deps.db, { positionId: 'POS-01', candidates: [
      { id: 'C-B', experienceYears: 1.5, skills: [{ name: '供应商管理', level: 1 }, { name: '成本分析', level: 0 }, { name: 'SAP', level: 2 }] },
      { id: 'C-A', experienceYears: 10, skills: full },
    ] });
    const totals = result.artifacts![0].rows.filter((r) => r[1] === '合计');
    expect(totals.map((r) => [r[0], r[5]])).toEqual([['C-B', 45], ['C-A', 100]]);
    expect(listPositions(env.deps.db)).toEqual(before);
    expect(result.actions ?? []).toHaveLength(0);
  });

  it('does not give missing or conflicting evidence a numeric total', () => {
    const result = screenCandidates(env.deps.db, { positionId: 'POS-01', candidates: [
      { id: 'C-01', skills: [{ name: 'ERP', level: 2 }, { name: 'SAP', level: 0 }] },
    ] });
    expect(result.artifacts![0].rows.at(-1)![5]).toBe('待核');
    expect(result.pending).toHaveLength(4);
    expect(result.pending?.join()).toContain('记录冲突');
  });

  it('does not double count duplicate aliases', () => {
    const result = screenCandidates(env.deps.db, { positionId: 'POS-01', candidates: [{ id: 'C-01', experienceYears: 3, skills: [...full, { name: 'SAP', level: 2 }] }] });
    expect(result.artifacts![0].rows.at(-1)![5]).toBe(100);
  });

  it('rejects invalid or sensitive profile fields and unsupported roles through the API', async () => {
    const cookie = await env.login('hr');
    const path = '/api/modules/hr/screening';
    const base = { positionId: 'POS-01', candidates: [{ id: 'C-01', experienceYears: 3, skills: full }] };
    expect((await env.send('POST', path, base, { Cookie: cookie })).status).toBe(200);
    for (const change of [{ age: 25 }, { gender: '女' }, { experienceYears: -1 }, { skills: [{ name: 'ERP', level: 4 }] }]) {
      expect((await env.send('POST', path, { ...base, candidates: [{ ...base.candidates[0], ...change }] }, { Cookie: cookie })).status).toBe(400);
    }
    expect((await env.send('POST', path, { ...base, candidates: [base.candidates[0], base.candidates[0]] }, { Cookie: cookie })).status).toBe(400);
    expect((await env.send('POST', path, { ...base, positionId: 'POS-999' }, { Cookie: cookie })).status).toBe(404);
  });

  it('plans training only for assessed gaps with course hours, dates and acceptance criteria', () => {
    const result = trainingPlan(env.deps.db, { positionId: 'POS-02', skills: [{ name: 'Python', level: 2 }, { name: '机器人仿真', level: 1 }, { name: '机器视觉', level: 0 }] }, env.deps.clock());
    expect(result.headline).toContain('16 学时');
    expect(result.artifacts![0].rows.map((r) => r[6])).toEqual(['2026-11-06', '2026-11-13']);
    expect(result.artifacts![0].rows.every((r) => String(r[7]).length > 5)).toBe(true);
    expect(result.actions).toHaveLength(2);
    expect(result.actions?.every((a) => a.owner === '智能物流部负责人')).toBe(true);
  });

  it('requests assessment for missing skills and creates no training for completed skills', () => {
    const unknown = trainingPlan(env.deps.db, { positionId: 'POS-01', skills: [] }, env.deps.clock());
    expect(unknown.pending).toHaveLength(3);
    expect(unknown.actions?.every((a) => a.title.endsWith('技能评估'))).toBe(true);
    const complete = trainingPlan(env.deps.db, { positionId: 'POS-01', skills: full }, env.deps.clock());
    expect(complete.artifacts![0].rows).toHaveLength(0);
    expect(complete.actions).toHaveLength(0);
  });

  it('runs the new workbench agents end to end and creates training tasks', async () => {
    const cookie = await env.login('hr');
    const catalog = await env.get('/api/catalog', cookie);
    const inputs = {
      'hr.recruitment': { positionId: 'POS-01', candidates: [{ id: 'C-01', experienceYears: 3, skills: full }] },
      'hr.training': { positionId: 'POS-02', skills: [{ name: '机器人仿真', level: 1 }, { name: 'Python', level: 2 }, { name: '机器视觉', level: 0 }] },
    };
    for (const agentId of ['hr.recruitment', 'hr.training']) {
      const agent = catalog.body.agents.find((a: { id: string }) => a.id === agentId);
      expect(agent).toBeTruthy();
      const question = JSON.stringify(inputs[agentId as keyof typeof inputs]);
      const result = await env.send('POST', '/api/agents/' + agentId + '/turns', { question }, { Cookie: cookie });
      expect(result.status).toBe(200);
      expect(result.body.turn.mode).toBe('offline');
      expect(result.body.turn.result.artifacts[0].rows.length).toBeGreaterThan(0);
      if (agentId === 'hr.training') {
        expect(listTasks(env.deps.db, ['hr'])).toHaveLength(2);
        await env.send('DELETE', '/api/turns/' + result.body.turn.id, undefined, { Cookie: cookie });
        expect(listTasks(env.deps.db, ['hr'])).toHaveLength(0);
      }
    }
    const malformed = await env.send('POST', '/api/agents/hr.recruitment/turns', { question: '初筛 {"positionId": "POS-01",' }, { Cookie: cookie });
    expect(malformed.body.turn.result.pending.join()).toContain('格式无效');
    expect(malformed.body.turn.result.artifacts).toHaveLength(0);
  });

  it('scopes organization questions to the requested department without private attrition fields', async () => {
    const cookie = await env.login('hr');
    ingestEvent(env.deps, { domain: 'hr', type: 'attrition_risk', payload: { employeeName: '虚构员工甲', reason: '隐私原因', department: '供应链部', position: '采购工程师' }, source: { channel: 'manual' } });
    const result = await env.send('POST', '/api/agents/hr.org/turns', { question: '供应链部的人员情况' }, { Cookie: cookie });
    expect(result.body.turn.result.artifacts[0].rows).toHaveLength(1);
    expect(result.body.turn.result.artifacts[0].rows[0][0]).toBe('供应链部');
    expect(JSON.stringify(result.body.turn.result)).not.toMatch(/虚构员工甲|隐私原因/);
  });
});
