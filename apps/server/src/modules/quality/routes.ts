import type { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { requireScope } from '../../core/auth.ts';
import type { AppEnv, Deps } from '../../core/deps.ts';
import { newId } from '../../core/util.ts';
import { transaction } from '../../db.ts';
import { qualityDate, validDate } from './calendar.ts';
import { isClosedComplaint, isOverdue, listCapa, listComplaints } from './data.ts';
import { installQualityTracking, syncOverdueEvents } from './tracking.ts';

const CapaPatch = z.object({
  status: z.enum(['进行中', '已完成', '已取消']).optional(),
  due: z.string().refine(validDate, '请使用有效的 YYYY-MM-DD 日期').optional(),
  owner: z.string().trim().min(1).max(100).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '请提供要更新的字段');

const CapaCreate = z.object({
  title: z.string().trim().min(1).max(500),
  owner: z.string().trim().min(1).max(100),
  due: z.string().refine(validDate, '请使用有效的 YYYY-MM-DD 日期'),
  confirmed: z.literal(true),
}).strict();

export function qualityRoutes(app: Hono<AppEnv>, deps: Deps): void {
  installQualityTracking(deps);
  app.post('/complaints/:id/capa', async (c) => {
    requireScope(c, 'quality');
    const input = CapaCreate.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: '请确认整改事项、负责人和有效期限后再建档' }, 400);
    const complaint = listComplaints(deps.db).find((item) => item.id === c.req.param('id'));
    if (!complaint) return c.json({ error: '客诉编号未收录' }, 404);
    const saved = transaction(deps.db, () => {
      const existing = listCapa(deps.db).find((item) => item.complaintId === complaint.id && item.title === input.data.title && item.owner === input.data.owner && item.due === input.data.due);
      if (existing) return { capa: existing, created: false };
      if (isClosedComplaint(complaint)) throw new HTTPException(409, { message: '已结案或取消的客诉不能新建整改项，请先核实客诉状态' });
      const id = newId('CAPA');
      deps.db.prepare('INSERT INTO quality_capa (id, complaint_id, title, owner, due, status) VALUES (?, ?, ?, ?, ?, ?)').run(id, complaint.id, input.data.title, input.data.owner, input.data.due, '进行中');
      return { capa: listCapa(deps.db).find((item) => item.id === id)!, created: true };
    });
    syncOverdueEvents(deps);
    return c.json({ ...saved, overdue: isOverdue(saved.capa, qualityDate(deps.clock())) }, saved.created ? 201 : 200);
  });
  app.patch('/capa/:id', async (c) => {
    requireScope(c, 'quality');
    const patch = CapaPatch.safeParse(await c.req.json().catch(() => null));
    if (!patch.success) return c.json({ error: '整改项参数无效，请核实状态、日期或负责人' }, 400);
    const item = listCapa(deps.db).find((r) => r.id === c.req.param('id'));
    if (!item) return c.json({ error: '整改项未收录' }, 404);
    deps.db.prepare('UPDATE quality_capa SET status = ?, due = ?, owner = ? WHERE id = ?').run(
      patch.data.status ?? item.status, patch.data.due ?? item.due, patch.data.owner ?? item.owner, item.id,
    );
    syncOverdueEvents(deps);
    const updated = listCapa(deps.db).find((r) => r.id === item.id)!;
    return c.json({ capa: updated, overdue: isOverdue(updated, qualityDate(deps.clock())) });
  });
}
