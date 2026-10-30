import { timingSafeEqual } from 'node:crypto';
import { DOMAINS } from '@agentos/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Deps } from './deps.ts';
import { ingestEvent } from './events.ts';

export const BRIDGE_HEADER = 'X-Bridge-Token';

/** Machine-to-machine auth for the simulation bridge and the demo replay. */
export function requireBridgeToken(c: Context<AppEnv>, deps: Deps): void {
  const expected = deps.config.bridgeToken;
  if (!expected) throw new HTTPException(503, { message: '服务端未配置 BRIDGE_TOKEN，事件桥未启用' });
  const given = c.req.header(BRIDGE_HEADER) ?? '';
  const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw new HTTPException(401, { message: '事件桥令牌无效' });
}

const BridgeEvent = z.object({
  domain: z.enum(DOMAINS).default('logistics'),
  type: z.string().min(1),
  severity: z.enum(['info', 'warn', 'critical']).optional(),
  title: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
  station: z.string().max(100).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  count: z.number().int().min(1).max(1000).optional(),
  occurredAt: z.string().datetime().optional(),
  dedupeKey: z.string().max(200).optional(),
  channel: z.enum(['bridge', 'replay']).default('bridge'),
});

export function bridgeRoutes(app: Hono<AppEnv>, deps: Deps): void {
  // Accepts one event or an array. Unknown event types are rejected with 400.
  app.post('/api/bridge/events', async (c) => {
    requireBridgeToken(c, deps);
    const body = await c.req.json().catch(() => null);
    const parsed = z.array(BridgeEvent).min(1).max(200).safeParse(Array.isArray(body) ? body : [body]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HTTPException(400, { message: `事件格式错误：${issue?.path.join('.')} ${issue?.message}` });
    }
    const results = parsed.data.map((e) =>
      ingestEvent(deps, {
        domain: e.domain,
        type: e.type,
        severity: e.severity,
        title: e.title,
        summary: e.summary,
        payload: e.payload,
        count: e.count,
        dedupeKey: e.dedupeKey,
        at: e.occurredAt ? new Date(e.occurredAt) : undefined,
        source: { channel: e.channel, station: e.station, actor: e.channel === 'replay' ? '演示回放' : '仿真事件桥' },
      }),
    );
    return c.json({ events: results.map((r) => ({ id: r.event.id, created: r.created, count: r.event.count })) });
  });
}
