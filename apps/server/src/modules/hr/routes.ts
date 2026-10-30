import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireAccount, requireScope } from '../../core/auth.ts';
import type { AppEnv, Deps } from '../../core/deps.ts';
import { setEventStatus } from '../../core/events.ts';
import { listRequests, RequestStatus } from './requests.ts';
import { findRole, jobDescription, listRoleProfiles, screenCandidates, ScreeningSchema, trainingPlan, TrainingSchema } from './talent.ts';
import { activeKnowledge, archiveKnowledge, createKnowledgeDraft, CreateKnowledge, listKnowledge, publishKnowledge, updateKnowledgeDraft, UpdateKnowledge } from './knowledge.ts';
import type { Row } from '../../db.ts';

async function readBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success) throw new HTTPException(400, { message: '请求字段无效，请检查必填内容、日期、技能等级或版本' });
  return result.data;
}

const RequestUpdate = z.object({
  status: RequestStatus,
  answer: z.string().trim().max(4000).optional(),
}).strict();

export function hrRoutes(app: Hono<AppEnv>, deps: Deps): void {
  // These authenticated self-service handlers terminate before the HR-only middleware.
  const service = new Hono<AppEnv>();
  service.use('*', async (c, next) => { requireAccount(c); await next(); });
  service.get('/requests', (c) => c.json(listRequests(deps.db, requireAccount(c).id)));
  service.get('/policies', (c) => c.json(activeKnowledge(deps.db, deps.clock()).map((v) => ({
    documentId: v.documentId, title: v.title, category: v.category, version: v.version,
    scope: v.scope, content: v.content, kind: v.kind, effectiveFrom: v.effectiveFrom,
  }))));
  app.route('/service', service);
  app.use('*', async (c, next) => { requireScope(c, 'hr'); await next(); });

  app.get('/knowledge', (c) => c.json(listKnowledge(deps.db)));
  app.post('/knowledge', async (c) => c.json(createKnowledgeDraft(deps.db, await readBody(c, CreateKnowledge)), 201));
  app.patch('/knowledge/:id', async (c) => c.json(updateKnowledgeDraft(deps.db, c.req.param('id'), await readBody(c, UpdateKnowledge))));
  app.post('/knowledge/:id/publish', async (c) => {
    const input = await readBody(c, z.object({ revision: z.number().int().positive(), reviewedForEmployees: z.literal(true) }).strict());
    return c.json(publishKnowledge(deps.db, c.req.param('id'), input.revision, requireAccount(c).displayName, deps.clock()));
  });
  app.post('/knowledge/documents/:id/archive', async (c) => {
    const input = await readBody(c, z.object({ archived: z.boolean() }).strict());
    archiveKnowledge(deps.db, c.req.param('id'), input.archived);
    return c.json({ ok: true });
  });
  app.get('/service-metrics', (c) => {
    const rows = deps.db.prepare("SELECT json_extract(result_json, '$.policy.outcome') AS outcome, COUNT(*) AS n, AVG(latency_ms) AS latency FROM turns WHERE agent_id = 'hr.service' AND json_extract(result_json, '$.policy.outcome') IS NOT NULL GROUP BY outcome").all() as Row[];
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    const count = (outcome: string) => Number(rows.find((r) => r.outcome === outcome)?.n ?? 0);
    const faq = deps.db.prepare("SELECT COUNT(DISTINCT t.id) AS n FROM turns t, json_each(t.result_json, '$.policy.citations') c WHERE t.agent_id = 'hr.service' AND json_extract(t.result_json, '$.policy.outcome') = 'answered' AND json_extract(c.value, '$.kind') = 'faq'").get() as Row;
    return c.json({
      total, answered: count('answered'), clarify: count('clarify'), handoff: count('handoff'), faqReuse: Number(faq.n),
      averageLatencyMs: total ? Math.round(rows.reduce((sum, r) => sum + Number(r.n) * Number(r.latency), 0) / total) : null,
      activeDocuments: activeKnowledge(deps.db, deps.clock()).length,
    });
  });

  app.get('/requests', (c) => c.json(listRequests(deps.db)));
  app.patch('/requests/:id', async (c) => {
    const account = requireScope(c, 'hr');
    const request = listRequests(deps.db).find((r) => r.id === c.req.param('id'));
    if (!request) throw new HTTPException(404, { message: '服务请求不存在' });
    const update = await readBody(c, RequestUpdate);
    const answer = update.answer ?? request.answer;
    if (update.status === '已解决' && !answer) throw new HTTPException(400, { message: '请填写处理答复后再解决请求' });
    deps.db.prepare(`INSERT INTO hr_request_links (request_id, answer, handled_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET answer = excluded.answer, handled_by = excluded.handled_by, updated_at = excluded.updated_at`)
      .run(request.id, answer, account.displayName, deps.clock().toISOString());
    if (request.eventId) {
      setEventStatus(deps, request.eventId, update.status === '已解决' ? 'resolved' : update.status === '处理中' ? 'acknowledged' : 'open');
    } else {
      deps.db.prepare('UPDATE hr_requests SET status = ? WHERE id = ?').run(update.status, request.id);
    }
    return c.json(listRequests(deps.db).find((r) => r.id === request.id));
  });

  app.get('/roles', (c) => c.json(listRoleProfiles(deps.db)));
  app.get('/roles/:id/jd', (c) => {
    if (!findRole(deps.db, c.req.param('id'))) throw new HTTPException(404, { message: '岗位要求未收录' });
    return c.json(jobDescription(deps.db, c.req.param('id')));
  });
  app.post('/screening', async (c) => {
    const input = await readBody(c, ScreeningSchema);
    if (!findRole(deps.db, input.positionId)) throw new HTTPException(404, { message: '岗位要求未收录' });
    return c.json(screenCandidates(deps.db, input));
  });
  app.post('/training-plan', async (c) => {
    const input = await readBody(c, TrainingSchema);
    if (!findRole(deps.db, input.positionId)) throw new HTTPException(404, { message: '岗位要求未收录' });
    return c.json(trainingPlan(deps.db, input, deps.clock()));
  });
}
