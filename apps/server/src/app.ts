import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Account, Catalog, Cockpit, Domain, ModuleOverview, Session, StreamMessage } from '@agentos/shared';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Config } from './config.ts';
import { createProvider } from './core/agents/providers.ts';
import { deleteTurn, getConversation, listTurns, rowToConversation, rowToTurn, runTurn } from './core/agents/runtime.ts';
import { login, logout, requireAccount, requireScope, rowToAccount, SESSION_COOKIE, sessionMiddleware } from './core/auth.ts';
import { bridgeRoutes } from './core/bridge.ts';
import { Bus, type AppEnv, type Deps } from './core/deps.ts';
import { getEvent, listEvents, redactEvent, setEventStatus } from './core/events.ts';
import { getTask, listMemory, listTasks, setTaskStatus } from './core/memory.ts';
import { Registry } from './core/registry.ts';
import { canSee, canUseAgent, domainsFor } from './core/roles.ts';
import { computeSituation, listSignals, rowToSignal, signalEvents } from './core/signals.ts';
import { openDb, migrate, type DB, type Row } from './db.ts';
import { rankSignals } from './executive/briefing.ts';
import * as cases from './executive/cases.ts';
import { EXECUTIVE_AGENTS, MODULES } from './modules/index.ts';
import { companyFor } from './seed/company.ts';

export function createDeps(config: Config, overrides: Partial<Pick<Deps, 'db' | 'clock' | 'provider'>> = {}): Deps {
  const registry = new Registry(MODULES, EXECUTIVE_AGENTS, config.dataset);
  const db: DB = overrides.db ?? openDb(config.dbPath);
  migrate(db, registry.modules.map((m) => m.schema ?? ''));
  for (const module of registry.modules) module.migrate?.(db);
  return {
    db,
    config,
    company: companyFor(config.dataset),
    registry,
    bus: new Bus(),
    provider: overrides.provider ?? createProvider(config.llm),
    clock: overrides.clock ?? (() => new Date()),
    situationCache: new Map(),
  };
}

const BRIEFING_AGENT = 'executive.briefing';
const BRIEFING_QUESTION = '今天最需要我决定的三件事是什么？逐项说明影响、建议负责人和完成时间。';

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });
const TurnBody = z.object({ question: z.string().min(1).max(4000), conversationId: z.string().nullish(), sourceTurnId: z.string().max(100).nullish(), sourceFindingId: z.string().max(100).nullish() });
const EventStatusBody = z.object({ status: z.enum(['open', 'acknowledged', 'resolved']) });
const TaskStatusBody = z.object({ status: z.enum(['open', 'done']) });
const text = (max: number) => z.string().max(max);
const CaseCreateBody = z.union([
  z.object({ signalId: z.string().min(1).max(120) }),
  z.object({ turnId: z.string().min(1).max(100), findingId: z.string().min(1).max(100) }),
]);
const CaseAskBody = z.object({ agentId: z.string().min(1).max(100), question: text(2000) });
const CaseActionBody = z.object({
  fromEntryId: z.string().max(100).optional(),
  actionIndex: z.number().int().min(0).max(20).optional(),
  title: text(200).optional(),
  domain: z.enum(['production', 'supply', 'quality', 'logistics', 'ehs', 'hr']).optional(),
  owner: text(60).optional(),
  due: text(20).optional(),
});
const CaseReceiptBody = z.object({ actionEntryId: z.string().min(1).max(100), note: text(500), simulated: z.boolean().default(false) });
const CaseVerifyBody = z.object({ mode: z.enum(['auto', 'manual']), passed: z.boolean().optional(), criterion: text(300).optional(), note: text(500).optional() });
const CaseLessonBody = z.object({ title: text(80).optional(), symptom: text(300).optional(), conditions: text(500), measure: text(500).optional(), conclusion: z.enum(['effective', 'ineffective']) });

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: '请求参数错误' });
  return parsed.data;
}

function sessionFor(deps: Deps, account: Account): Session {
  return { account, company: deps.company, domains: domainsFor(account.role) };
}

/** Domains the account may see, optionally narrowed by a ?domain= filter. */
function visibleDomains(account: Account, filter?: string): Domain[] {
  const domains = domainsFor(account.role);
  return filter ? domains.filter((d) => d === filter) : domains;
}

function visibleMessage(deps: Deps, account: Account, message: StreamMessage): StreamMessage | null {
  const role = account.role;
  switch (message.kind) {
    case 'event.created':
    case 'event.updated':
      return canSee(role, message.event.domain) ? { ...message, event: redactEvent(deps, message.event, role) } : null;
    case 'signal.raised':
    case 'signal.updated':
    case 'signal.cleared':
      return canSee(role, message.signal.domain) ? message : null;
    case 'situation.updated':
      return canSee(role, message.situation.domain) ? message : null;
    case 'task.created':
      return canSee(role, message.task.domain) ? message : null;
  }
}

function onError(err: Error, c: { json(body: unknown, status?: number): Response }) {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: '服务器内部错误' }, 500);
}

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('/api/*', sessionMiddleware(deps));

  app.get('/api/health', (c) => c.json({ ok: true }));

  // --- Session ---------------------------------------------------------------
  app.post('/api/auth/login', async (c) => {
    const { username, password } = await body(c, LoginBody);
    const result = login(deps, username, password);
    if (!result) throw new HTTPException(401, { message: '账号或密码错误' });
    setCookie(c, SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: new URL(c.req.url).protocol === 'https:',
      maxAge: deps.config.sessionHours * 3600,
    });
    return c.json(sessionFor(deps, result.account));
  });

  app.post('/api/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) logout(deps.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/session', (c) => c.json(sessionFor(deps, requireAccount(c))));

  app.get('/api/catalog', (c) => {
    const account = requireAccount(c);
    const catalog: Catalog = {
      modules: deps.registry.modules
        .filter((m) => canSee(account.role, m.id))
        .map((m) => ({ id: m.id, name: m.name, description: m.description })),
      agents: deps.registry
        .agents()
        .filter((a) => canUseAgent(account.role, a))
        .map((a) => ({ id: a.id, module: a.module, name: a.name, description: a.description, starters: deps.registry.starters(a), ...(a.companyService ? { companyService: true } : {}) })),
      llm: { mode: deps.provider.mode, model: deps.provider.model },
    };
    return c.json(catalog);
  });

  // --- Agents and conversations ---------------------------------------------
  app.get('/api/conversations', (c) => {
    const account = requireAccount(c);
    const agentId = c.req.query('agentId');
    const domain = c.req.query('domain');
    const areaAgents = domain ? deps.registry.agents().filter(a => a.module === domain && !a.companyService && canUseAgent(account.role, a)).map(a => a.id) : [];
    if (!agentId && domain && !areaAgents.length) return c.json([]);
    const rows = (
      agentId
        ? deps.db.prepare('SELECT * FROM conversations WHERE account_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT 100').all(account.id, agentId)
        : domain
          ? deps.db.prepare(`SELECT * FROM conversations WHERE account_id = ? AND agent_id IN (${areaAgents.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 100`).all(account.id, ...areaAgents)
          : deps.db.prepare('SELECT * FROM conversations WHERE account_id = ? ORDER BY updated_at DESC LIMIT 100').all(account.id)
    ) as Row[];
    return c.json(rows.map(rowToConversation));
  });

  app.get('/api/conversations/:id', (c) => {
    const account = requireAccount(c);
    const conversation = getConversation(deps, account, c.req.param('id'));
    return c.json({ conversation, turns: listTurns(deps, conversation.id) });
  });

  app.delete('/api/conversations/:id', (c) => {
    const account = requireAccount(c);
    const conversation = getConversation(deps, account, c.req.param('id'));
    for (const turn of listTurns(deps, conversation.id)) deleteTurn(deps, account, turn.id);
    deps.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/turns', async (c) => {
    const account = requireAccount(c);
    const request = await body(c, TurnBody);
    const agentId = c.req.param('agentId');
    if (!c.req.header('accept')?.includes('text/event-stream')) return c.json(await runTurn(deps, { account, agentId, ...request }));
    // Streaming: "delta" events carry answer text as the model writes it, then "turn" carries the saved result.
    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const onAnswer = (text: string) => {
        writes = writes.then(() => stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) }));
      };
      try {
        const result = await runTurn(deps, { account, agentId, ...request, onAnswer });
        await writes;
        await stream.writeSSE({ event: 'turn', data: JSON.stringify(result) });
      } catch (error) {
        await writes;
        const message = error instanceof HTTPException ? error.message : '回答失败，请重试';
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: message }) });
      }
    });
  });

  app.delete('/api/turns/:id', (c) => {
    deleteTurn(deps, requireAccount(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- Events, signals, cockpit ---------------------------------------------
  app.get('/api/events', (c) => {
    const account = requireAccount(c);
    const status = c.req.query('status') as 'open' | 'acknowledged' | 'resolved' | 'unresolved' | undefined;
    const events = listEvents(deps, {
      domains: visibleDomains(account, c.req.query('domain')),
      status,
      limit: Number(c.req.query('limit') ?? 100),
      sort: c.req.query('sort') === 'severity' ? 'severity' : 'recent',
    });
    return c.json(events.map((e) => redactEvent(deps, e, account.role)));
  });

  app.patch('/api/events/:id', async (c) => {
    const account = requireAccount(c);
    const event = getEvent(deps, c.req.param('id'));
    if (!event || !canSee(account.role, event.domain)) throw new HTTPException(404, { message: '事件不存在' });
    const { status } = await body(c, EventStatusBody);
    const updated = setEventStatus(deps, event.id, status);
    // A rule can immediately raise a new event if the underlying business condition still holds.
    const replacement = status === 'resolved' ? deps.db.prepare(`SELECT id FROM events WHERE domain = ? AND type = ? AND dedupe_key = (SELECT dedupe_key FROM events WHERE id = ?) AND id <> ? AND status != 'resolved' ORDER BY last_seen_at DESC LIMIT 1`).get(event.domain, event.type, event.id, event.id) as Row | undefined : undefined;
    let activeEvent = replacement ? getEvent(deps, String(replacement.id)) : null;
    if (activeEvent) {
      // This belongs to the event, not to the client's last clicked row. Preserve it across reloads and later actions.
      deps.db.prepare('UPDATE events SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...activeEvent.payload, reopenedFromEventId: event.id }), activeEvent.id);
      activeEvent = getEvent(deps, activeEvent.id)!;
      deps.bus.publish({ kind: 'event.updated', event: activeEvent });
    }
    return c.json({ ...redactEvent(deps, updated, account.role), ...(activeEvent ? { activeEvent: redactEvent(deps, activeEvent, account.role) } : {}) });
  });

  app.get('/api/signals', (c) => {
    const account = requireAccount(c);
    return c.json(rankSignals(listSignals(deps, visibleDomains(account, c.req.query('domain')))));
  });

  app.get('/api/signals/:id', (c) => {
    const account = requireAccount(c);
    const row = deps.db.prepare('SELECT * FROM signals WHERE id = ?').get(c.req.param('id')) as Row | undefined;
    const signal = row ? rowToSignal(row) : null;
    if (!signal || !canSee(account.role, signal.domain)) throw new HTTPException(404, { message: '信号不存在' });
    return c.json({ signal, events: signalEvents(deps, signal).map((e) => redactEvent(deps, e, account.role)) });
  });

  app.get('/api/cockpit', (c) => {
    const account = requireAccount(c);
    const domains = domainsFor(account.role);
    const scopes = account.role === 'executive' ? [...domains, 'executive' as const] : domains;
    // Only turns produced by the briefing button; follow-up questions to the same agent don't replace it.
    const briefing = deps.db
      .prepare('SELECT * FROM turns WHERE account_id = ? AND agent_id = ? AND input = ? ORDER BY created_at DESC LIMIT 1')
      .get(account.id, BRIEFING_AGENT, BRIEFING_QUESTION) as Row | undefined;
    const cockpit: Cockpit = {
      situations: domains.map((d) => computeSituation(deps, d)),
      signals: rankSignals(listSignals(deps, domains)),
      events: listEvents(deps, { domains, limit: 40 }).map((e) => redactEvent(deps, e, account.role)),
      tasks: listTasks(deps.db, scopes),
      briefing: briefing ? rowToTurn(briefing) : null,
    };
    return c.json(cockpit);
  });

  // Each briefing starts a fresh conversation, so it reflects the current situation rather than earlier chat.
  app.post('/api/cockpit/briefing', async (c) => {
    const account = requireScope(c, 'executive');
    return c.json(await runTurn(deps, { account, agentId: BRIEFING_AGENT, question: BRIEFING_QUESTION }));
  });

  // --- Collaboration cases: one item, several roles, a verifiable outcome ------------------------------------
  app.get('/api/cases', (c) => c.json(cases.listCases(deps, requireAccount(c))));

  app.post('/api/cases', async (c) => {
    const account = requireAccount(c);
    const request = await body(c, CaseCreateBody);
    const result = 'signalId' in request ? cases.createFromSignal(deps, account, request.signalId) : await cases.createFromDiscovery(deps, account, request.turnId, request.findingId);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get('/api/cases/:id', (c) => c.json(cases.caseDetail(deps, requireAccount(c), c.req.param('id'))));

  const caseAction = (path: string, run: (account: Account, id: string, c: Parameters<typeof body>[0]) => void | Promise<void>) =>
    app.post(`/api/cases/:id/${path}`, async (c) => {
      const account = requireAccount(c);
      await run(account, c.req.param('id'), c);
      return c.json(cases.caseDetail(deps, account, c.req.param('id')));
    });
  caseAction('candidates', async (a, id, c) => cases.addCandidate(deps, a, id, (await body(c, z.object({ signalId: z.string().min(1).max(120) }))).signalId));
  caseAction('ask', async (a, id, c) => { const b = await body(c, CaseAskBody); await cases.askInCase(deps, a, id, b.agentId, b.question); });
  caseAction('actions', async (a, id, c) => cases.confirmAction(deps, a, id, await body(c, CaseActionBody)));
  caseAction('receipts', async (a, id, c) => cases.confirmReceipt(deps, a, id, await body(c, CaseReceiptBody)));
  caseAction('submit', (a, id) => cases.submitForVerification(deps, a, id));
  caseAction('verify', async (a, id, c) => cases.verifyCase(deps, a, id, await body(c, CaseVerifyBody)));
  caseAction('reopen', (a, id) => cases.reopenCase(deps, a, id));
  caseAction('lesson', async (a, id, c) => cases.saveLesson(deps, a, id, await body(c, CaseLessonBody)));
  caseAction('references', async (a, id, c) => cases.referenceLesson(deps, a, id, (await body(c, z.object({ lessonId: z.string().min(1).max(100) }))).lessonId));

  // --- Memory and tasks ------------------------------------------------------
  app.get('/api/memory', (c) => {
    const account = requireAccount(c);
    const scopes = account.role === 'executive' ? [...domainsFor(account.role), 'executive' as const] : domainsFor(account.role);
    return c.json(listMemory(deps.db, scopes, 200, account.id));
  });

  app.get('/api/tasks', (c) => {
    const account = requireAccount(c);
    const scopes = account.role === 'executive' ? [...domainsFor(account.role), 'executive' as const] : domainsFor(account.role);
    return c.json(listTasks(deps.db, scopes, (c.req.query('status') as 'open' | 'done' | 'all') ?? 'open'));
  });

  app.patch('/api/tasks/:id', async (c) => {
    const account = requireAccount(c);
    const task = getTask(deps.db, c.req.param('id'));
    if (!task || !canSee(account.role, task.domain)) throw new HTTPException(404, { message: '待办不存在' });
    const { status } = await body(c, TaskStatusBody);
    setTaskStatus(deps.db, task.id, status);
    return c.json(getTask(deps.db, task.id));
  });

  // --- Modules ---------------------------------------------------------------
  app.get('/api/modules/:id/overview', (c) => {
    const id = c.req.param('id');
    if (!deps.registry.hasModule(id)) throw new HTTPException(404, { message: '未知模块' });
    requireScope(c, id);
    const module = deps.registry.module(id);
    const { metrics, tables } = module.overview({ db: deps.db, now: deps.clock() });
    const overview: ModuleOverview = {
      module: { id: module.id, name: module.name, description: module.description },
      situation: computeSituation(deps, id),
      metrics,
      tables,
    };
    return c.json(overview);
  });

  for (const module of deps.registry.modules) {
    if (!module.routes) continue;
    const sub = new Hono<AppEnv>();
    sub.onError(onError);
    module.routes(sub, deps);
    app.route(`/api/modules/${module.id}`, sub);
  }

  bridgeRoutes(app, deps);

  app.get('/api/accounts', (c) => {
    requireScope(c, 'executive');
    const rows = deps.db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM conversations c WHERE c.account_id = a.id) AS conversations
         FROM accounts a ORDER BY a.created_at`,
      )
      .all() as Row[];
    return c.json(rows.map((r) => ({ ...rowToAccount(r), conversations: Number(r.conversations) })));
  });

  // --- Live stream -----------------------------------------------------------
  app.get('/api/stream', (c) => {
    const account = requireAccount(c);
    return streamSSE(c, async (stream) => {
      const queue: StreamMessage[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const unsubscribe = deps.bus.subscribe((message) => {
        const visible = visibleMessage(deps, account, message);
        if (!visible) return;
        queue.push(visible);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!closed) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), stream.sleep(25_000)]);
          wake = null;
        }
        if (closed) break;
        if (queue.length === 0) {
          await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
          continue;
        }
        while (queue.length) {
          const message = queue.shift()!;
          await stream.writeSSE({ event: message.kind, data: JSON.stringify(message) });
        }
      }
    });
  });

  app.all('/api/*', () => {
    throw new HTTPException(404, { message: '接口不存在' });
  });

  // --- Built web app (production) -------------------------------------------
  if (deps.config.webDist) {
    const root = relative(process.cwd(), deps.config.webDist) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
