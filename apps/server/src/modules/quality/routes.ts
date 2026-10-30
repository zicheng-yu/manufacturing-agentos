import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../core/auth.ts';
import type { AppEnv, Deps } from '../../core/deps.ts';
import { qualityDate, validDate } from './calendar.ts';
import { isOverdue, listCapa } from './data.ts';
import { installQualityTracking, syncOverdueEvents } from './tracking.ts';

const CapaPatch = z.object({
  status: z.enum(['进行中', '已完成', '已取消']).optional(),
  due: z.string().refine(validDate, '请使用有效的 YYYY-MM-DD 日期').optional(),
  owner: z.string().trim().min(1).max(100).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '请提供要更新的字段');

export function qualityRoutes(app: Hono<AppEnv>, deps: Deps): void {
  installQualityTracking(deps);
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
