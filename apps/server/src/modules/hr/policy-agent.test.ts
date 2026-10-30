import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import type { ChatMessage } from '../../core/agents/providers.ts';
import { migrate } from '../../db.ts';
import { activeKnowledge, archiveKnowledge, createKnowledgeDraft, listKnowledge, publishKnowledge, updateKnowledgeDraft } from './knowledge.ts';
import { hrModule } from './index.ts';

describe('company policy agent and governed knowledge', () => {
  let env: TestEnv;
  let hr: string;
  let employee: string;
  beforeEach(async () => { env = setup(); hr = await env.login('hr'); employee = await env.login('supply'); });
  afterEach(() => env.deps.db.close());
  const ask = (question: string, conversationId?: string, cookie = employee) =>
    env.send('POST', '/api/agents/hr.service/turns', { question, conversationId }, { Cookie: cookie });
  const fields = (changes: Record<string, unknown> = {}) => ({
    title: '班车乘坐规则', category: '员工服务', keywords: '班车 通勤', content: '员工可在公司前台领取通勤班车时刻表。',
    scope: '全体员工', effectiveFrom: '2026-10-30', effectiveTo: null, kind: 'policy' as const, ...changes,
  });
  const create = (changes: Record<string, unknown> = {}) => env.send('POST', '/api/modules/hr/knowledge', fields(changes), { Cookie: hr });
  const publish = (id: string, revision = 1) => env.send('POST', '/api/modules/hr/knowledge/' + id + '/publish', { revision, reviewedForEmployees: true }, { Cookie: hr });
  const model = (fn: (messages: ChatMessage[]) => Promise<string> | string) => {
    env.deps.provider = { mode: 'llm', model: 'test-grounding-model', complete: async (messages) => fn(messages) };
  };

  it('opens only the company service while keeping all HR management and other employee records private', async () => {
    const response = await ask('年假有几天？');
    expect(response.status).toBe(200);
    expect(response.body.turn.result.policy.outcome).toBe('answered');
    for (const path of ['/api/modules/hr/overview', '/api/modules/hr/requests', '/api/modules/hr/knowledge', '/api/modules/hr/service-metrics', '/api/modules/hr/roles']) {
      expect((await env.get(path, employee)).status).toBe(403);
    }
    expect((await env.get('/api/modules/hr/service/policies', '')).status).toBe(401);
    expect((await env.get('/api/modules/hr/service/requests', '')).status).toBe(401);
    expect((await env.send('POST', '/api/modules/hr/knowledge', fields(), { Cookie: employee })).status).toBe(403);
    expect((await env.send('POST', '/api/modules/hr/knowledge/P-01-v1/publish', {}, { Cookie: employee })).status).toBe(403);
    const other = await env.login('quality');
    expect((await env.get('/api/conversations/' + response.body.conversation.id, other)).status).toBe(404);
    expect((await env.send('POST', '/api/agents/hr.org/turns', { question: '人员情况' }, { Cookie: employee })).status).toBe(403);
  });

  it('asks for the leave type before creating a ticket and answers the follow-up with an exact version citation', async () => {
    const first = await ask('我想请假');
    expect(first.body.turn.result.policy.outcome).toBe('clarify');
    expect(first.body.turn.result.policy.questions[0]).toContain('哪类假期');
    expect(first.body.turn.result.eventIds).toHaveLength(0);
    const second = await ask('病假', first.body.conversation.id);
    expect(second.body.turn.result.policy.outcome).toBe('answered');
    expect(second.body.turn.result.policy.citations[0]).toMatchObject({ documentId: 'P-02', version: 1, section: 1 });
    expect(second.body.turn.result.policy.citations[0].quote).toContain('3 天以内由部门经理审批');
    expect((await env.get('/api/modules/hr/service/requests', employee)).body).toHaveLength(0);
  });

  it('lets an employee read their HR reply but never another account’s requests', async () => {
    const result = await ask('公司有班车吗？');
    const own = (await env.get('/api/modules/hr/service/requests', employee)).body;
    expect(own).toHaveLength(1);
    const other = await env.login('quality');
    await ask('公司有宿舍吗？', undefined, other);
    expect((await env.get('/api/modules/hr/service/requests', employee)).body).toHaveLength(1);
    expect((await env.get('/api/modules/hr/service/requests', other)).body[0].question).toBe('公司有宿舍吗？');
    expect((await env.get('/api/modules/hr/service/requests?accountId=someone-else', employee)).body).toHaveLength(1);
    await env.send('PATCH', '/api/modules/hr/requests/' + own[0].id, { status: '已解决', answer: '请到前台领取通勤安排表。' }, { Cookie: hr });
    const answered = (await env.get('/api/modules/hr/service/requests', employee)).body[0];
    expect(answered.status).toBe('已解决');
    expect(answered.answer).toContain('通勤安排表');
    expect(result.body.turn.result.policy.outcome).toBe('handoff');
  });

  it('keeps the original topic in an explicit human handoff', async () => {
    const first = await ask('年假有几天？');
    await ask('转人工', first.body.conversation.id);
    const request = (await env.get('/api/modules/hr/service/requests', employee)).body[0];
    expect(request.question).toContain('年假有几天');
    expect(request.history).toContain('年假有几天？');
    const other = await ask('出差住宿标准');
    await ask('转人工', other.body.conversation.id);
    expect((await env.get('/api/modules/hr/service/requests', employee)).body).toHaveLength(2);
  });

  it('keeps drafts out of retrieval and requires an explicit review before publication', async () => {
    const draft = await create();
    expect(draft.status).toBe(201);
    expect((await ask('班车怎么坐')).body.turn.result.policy.outcome).toBe('handoff');
    const visible = (await env.get('/api/modules/hr/service/policies', employee)).body;
    expect(visible.some((v: { documentId: string }) => v.documentId === draft.body.documentId)).toBe(false);
    expect((await env.send('POST', '/api/modules/hr/knowledge/' + draft.body.id + '/publish', { revision: 1 }, { Cookie: hr })).status).toBe(400);
    expect((await publish(draft.body.id)).status).toBe(200);
    const answer = (await ask('班车怎么坐')).body.turn.result;
    expect(answer.policy.outcome).toBe('answered');
    expect(answer.policy.citations[0].documentId).toBe(draft.body.documentId);
    expect(answer.answer).toContain('公司前台');
  });

  it('does not rewrite published content and rejects stale draft edits or approvals', async () => {
    const draft = createKnowledgeDraft(env.deps.db, fields());
    const { kind: _kind, ...values } = fields({ content: '员工可向前台申请公司通勤时刻表。' });
    const edited = updateKnowledgeDraft(env.deps.db, draft.id, { ...values, revision: 1 } as Parameters<typeof updateKnowledgeDraft>[2]);
    expect(edited.revision).toBe(2);
    expect(() => updateKnowledgeDraft(env.deps.db, draft.id, { ...values, revision: 1 } as Parameters<typeof updateKnowledgeDraft>[2])).toThrow('刷新');
    expect((await publish(draft.id, 1)).status).toBe(409);
    expect((await publish(draft.id, 2)).status).toBe(200);
    expect(() => updateKnowledgeDraft(env.deps.db, draft.id, { ...values, revision: 3 } as Parameters<typeof updateKnowledgeDraft>[2])).toThrow('新建修订');
  });

  it('activates a scheduled revision on its start date and never resurrects old text after expiration', async () => {
    const draft = await create({ documentId: 'P-01', title: '年休假', category: '假期', keywords: '年假',
      content: '演示修订：年假申请至少提前 5 个工作日提交。', effectiveFrom: '2026-11-01', effectiveTo: '2026-11-03' });
    expect((await publish(draft.body.id)).status).toBe(200);
    const before = (await ask('年假怎么申请')).body.turn.result;
    expect(before.policy.citations[0].version).toBe(1);
    env.advance(2 * 24 * 60);
    employee = await env.login('supply');
    const after = (await ask('年假怎么申请')).body.turn.result;
    expect(after.policy.citations[0].version).toBe(2);
    expect(after.answer).toContain('5 个工作日');
    env.advance(2 * 24 * 60);
    employee = await env.login('supply');
    expect(activeKnowledge(env.deps.db, env.deps.clock()).some((v) => v.documentId === 'P-01')).toBe(false);
    expect((await ask('年假怎么申请')).body.turn.result.policy.outcome).toBe('handoff');
  });

  it('archives all versions without disturbing other documents and can restore them', async () => {
    expect((await env.send('POST', '/api/modules/hr/knowledge/documents/P-01/archive', { archived: true }, { Cookie: hr })).status).toBe(200);
    expect((await ask('年假有几天')).body.turn.result.policy.outcome).toBe('handoff');
    expect((await ask('病假要什么证明')).body.turn.result.policy.outcome).toBe('answered');
    archiveKnowledge(env.deps.db, 'P-01', false);
    expect((await ask('年假有几天')).body.turn.result.policy.outcome).toBe('answered');
  });

  it('learns from a resolved answer only after HR generalizes and publishes the FAQ', async () => {
    await ask('公司有班车吗？');
    const request = (await env.get('/api/modules/hr/service/requests', employee)).body[0];
    const faqValues = { kind: 'faq', sourceRequestId: request.id, title: '公司有班车吗？', keywords: '哪里领取班车时刻表？',
      content: '员工可到公司前台领取班车时刻表，具体站点以当期时刻表为准。' };
    expect((await create(faqValues)).status).toBe(400);
    await env.send('PATCH', '/api/modules/hr/requests/' + request.id, { status: '已解决', answer: '示例员工可去前台领取班车时刻表。' }, { Cookie: hr });
    const draft = await create(faqValues);
    expect(draft.status).toBe(201);
    expect((await ask('公司有班车吗？')).body.turn.result.policy.outcome).toBe('handoff');
    expect((await publish(draft.body.id)).status).toBe(200);
    const next = await ask('公司有班车吗？');
    expect(next.body.turn.result.policy.outcome).toBe('answered');
    expect(next.body.turn.result.policy.citations[0].kind).toBe('faq');
    expect(next.body.turn.result.eventIds).toHaveLength(0);
    expect((await ask('请问哪里领取班车时刻表？')).body.turn.result.policy.outcome).toBe('answered');
    const metrics = (await env.get('/api/modules/hr/service-metrics', hr)).body;
    expect(metrics.faqReuse).toBe(2);
    expect(metrics.handoff).toBe(2);
  });

  it('does not auto-answer conflicting FAQs or personal-record questions', async () => {
    for (const content of ['请到公司前台领取班车时刻表。', '班车安排正在核实，请联系行政。']) {
      const draft = await create({ kind: 'faq', title: '公司有班车吗？', content });
      await publish(draft.body.id);
    }
    let called = false;
    model(() => { called = true; throw new Error('Must not choose an arbitrary FAQ'); });
    expect((await ask('公司有班车吗？')).body.turn.result.policy.outcome).toBe('handoff');
    expect((await ask('我的年假余额还有多少？')).body.turn.result.policy.outcome).toBe('handoff');
    expect(called).toBe(false);
  });

  it('retains independently reviewed FAQ knowledge when the employee deletes its source conversation', async () => {
    const turn = await ask('公司有班车吗？');
    const request = (await env.get('/api/modules/hr/service/requests', employee)).body[0];
    await env.send('PATCH', '/api/modules/hr/requests/' + request.id, { status: '已解决', answer: '请到前台领取时刻表。' }, { Cookie: hr });
    const draft = await create({ kind: 'faq', title: '公司有班车吗？', sourceRequestId: request.id, content: '员工可到前台领取班车时刻表。' });
    await publish(draft.body.id);
    expect((await env.send('DELETE', '/api/conversations/' + turn.body.conversation.id, undefined, { Cookie: employee })).status).toBe(200);
    expect((await env.get('/api/modules/hr/service/requests', employee)).body).toHaveLength(0);
    const faq = activeKnowledge(env.deps.db, env.deps.clock()).find((v) => v.id === draft.body.id)!;
    expect(faq.sourceRequestId).toBeNull();
    expect((await ask('公司有班车吗？')).body.turn.result.policy.outcome).toBe('answered');
  });

  it('uses the model for semantic retrieval while showing the whole verified clause', async () => {
    model((messages) => {
      const input = JSON.parse(messages.at(-1)!.content);
      expect(input.question).toBe('晚上干到第二天那笔补助怎么发');
      const source = input.sources.find((s: { sourceId: string }) => s.sourceId === 'P-05-v1:s1');
      return JSON.stringify({ outcome: 'answered', evidence: [{ sourceId: source.sourceId, quote: '随当月工资发放。' }], clarification: null });
    });
    const result = (await ask('晚上干到第二天那笔补助怎么发')).body.turn;
    expect(result.mode).toBe('llm');
    expect(result.result.policy.citations[0].documentId).toBe('P-05');
    expect(result.result.answer).toContain('22:00');
    expect(result.result.answer).toContain('每班补贴 30 元');
  });

  it('never sends draft, future or archived content to the model', async () => {
    const draft = await create({ content: '草稿标记 DRAFT-SECRET。' });
    const future = await create({ content: '未来标记 FUTURE-SECRET。', effectiveFrom: '2027-01-01' });
    await publish(future.body.id);
    archiveKnowledge(env.deps.db, 'P-05', true);
    model((messages) => {
      const input = messages.at(-1)!.content;
      expect(input).not.toContain('DRAFT-SECRET');
      expect(input).not.toContain('FUTURE-SECRET');
      expect(input).not.toContain('每班补贴 30 元');
      expect(input).not.toContain(draft.body.id);
      return JSON.stringify({ outcome: 'handoff', evidence: [], clarification: null });
    });
    expect((await ask('有什么夜班政策')).body.turn.mode).toBe('llm');
  });

  it.each([
    'not json',
    JSON.stringify({ outcome: 'answered', evidence: [{ sourceId: 'made-up', quote: '年假 99 天。' }], clarification: null }),
    JSON.stringify({ outcome: 'answered', evidence: [{ sourceId: 'P-01-v1:s1', quote: '年假 99 天。' }], clarification: null }),
    JSON.stringify({ outcome: 'answered', evidence: [], clarification: null }),
    JSON.stringify({ outcome: 'clarify', evidence: [], clarification: 'bank_account' }),
  ])('fails closed on an invalid model response: %s', async (raw) => {
    let calls = 0;
    model(() => { calls++; return raw; });
    const turn = (await ask('年假有几天')).body.turn;
    expect(calls).toBe(1);
    expect(turn.mode).toBe('offline');
    expect(turn.result.answer).not.toContain('99');
    expect(turn.result.policy.citations[0].documentId).toBe('P-01');
    expect(turn.result.pending.join()).toContain('未返回可核对');
  });

  it('rechecks sources after model completion if a policy is withdrawn in flight', async () => {
    model(() => {
      archiveKnowledge(env.deps.db, 'P-01', true);
      return JSON.stringify({ outcome: 'answered', evidence: [{ sourceId: 'P-01-v1:s1', quote: '入职满 1 年享 5 天带薪年假' }], clarification: null });
    });
    const result = (await ask('年假有几天')).body.turn.result;
    expect(result.policy.outcome).toBe('handoff');
    expect(result.policy.citations).toHaveLength(0);
    expect(result.answer).not.toContain('5 天');
  });

  it('handles provider failure without exposing raw provider errors', async () => {
    model(() => { throw new Error('secret-provider-details'); });
    const turn = (await ask('年假有几天')).body.turn;
    expect(turn.mode).toBe('offline');
    expect(JSON.stringify(turn.result)).not.toContain('secret-provider-details');
    expect(turn.result.policy.outcome).toBe('answered');
  });

  it('counts outcomes and actual latency, and deletion removes the deleted turn from metrics', async () => {
    await ask('年假有几天');
    await ask('我想请假');
    const manual = await ask('公司有班车吗');
    const metrics = (await env.get('/api/modules/hr/service-metrics', hr)).body;
    expect(metrics).toMatchObject({ total: 3, answered: 1, clarify: 1, handoff: 1, faqReuse: 0, activeDocuments: 10 });
    expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    await env.send('DELETE', '/api/turns/' + manual.body.turn.id, undefined, { Cookie: employee });
    expect((await env.get('/api/modules/hr/service-metrics', hr)).body.total).toBe(2);
  });

  it('migrates existing databases idempotently without overwriting published revisions', async () => {
    const draft = await create({ documentId: 'P-01', title: '年休假', content: '演示新版年假申请流程，提前五个工作日提交。' });
    await publish(draft.body.id);
    migrate(env.deps.db, [hrModule.schema!]);
    migrate(env.deps.db, [hrModule.schema!]);
    expect(listKnowledge(env.deps.db).filter((v) => v.documentId === 'P-01')).toHaveLength(2);
    expect(activeKnowledge(env.deps.db, env.deps.clock()).find((v) => v.documentId === 'P-01')?.version).toBe(2);
  });

  it('rejects impossible dates, expired publication and duplicate drafts', async () => {
    expect((await create({ effectiveFrom: '2026-02-30' })).status).toBe(400);
    expect((await create({ effectiveFrom: '2026-11-01', effectiveTo: '2026-10-30' })).status).toBe(400);
    const expired = await create({ effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01' });
    expect((await publish(expired.body.id)).status).toBe(400);
    const draft = await create({ documentId: 'P-01' });
    expect(draft.status).toBe(201);
    expect((await create({ documentId: 'P-01' })).status).toBe(409);
  });
});
