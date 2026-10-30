import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireScope } from '../../core/auth.ts';
import type { AppEnv, Deps } from '../../core/deps.ts';
import { setEventStatus } from '../../core/events.ts';
import { listRequests, RequestStatus } from './requests.ts';
import { findRole, jobDescription, listRoleProfiles, screenCandidates, ScreeningSchema, trainingPlan, TrainingSchema } from './talent.ts';

async function readBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success) throw new HTTPException(400, { message: '请求字段无效，请检查岗位编号、技能等级（0–3）及结构化字段' });
  return result.data;
}

const RequestUpdate = z.object({
  status: RequestStatus,
  answer: z.string().trim().max(4000).optional(),
}).strict();

export function hrRoutes(app: Hono<AppEnv>, deps: Deps): void {
  app.use('*', async (c, next) => { requireScope(c, 'hr'); await next(); });

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
