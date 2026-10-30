import type { AgentOSEvent, Domain, EventSource, EventStatus, Role, Severity } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { parseJson, type Row } from '../db.ts';
import type { Deps } from './deps.ts';
import { evaluateDomain } from './signals.ts';
import { addMinutes, newId } from './util.ts';

export interface EventInput {
  domain: Domain;
  type: string;
  severity?: Severity;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  source: EventSource;
  /** Events sharing a key merge while open. Defaults to domain:type:station plus the type's dedupeFields. */
  dedupeKey?: string;
  /** How many occurrences this input represents (the bridge may batch). */
  count?: number;
  at?: Date;
  turnId?: string | null;
}

/** Repeats of an open event within this window bump its count instead of creating a new row. */
export const DEDUPE_MINUTES = 10;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

export function rowToEvent(deps: Deps, row: Row): AgentOSEvent {
  const domain = row.domain as Domain;
  const type = String(row.type);
  return {
    id: String(row.id),
    domain,
    type,
    typeLabel: deps.registry.eventType(domain, type)?.label ?? type,
    severity: row.severity as Severity,
    title: String(row.title),
    summary: String(row.summary),
    payload: parseJson(row.payload_json, {}),
    source: parseJson(row.source_json, { channel: 'manual' }),
    dedupeKey: String(row.dedupe_key),
    count: Number(row.count),
    status: row.status as EventStatus,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    turnId: (row.turn_id as string | null) ?? null,
  };
}

export function getEvent(deps: Deps, id: string): AgentOSEvent | null {
  const row = deps.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToEvent(deps, row) : null;
}

/**
 * Store an event (or merge it into an open duplicate), let the owning module react,
 * then re-evaluate the domain's signals and situation.
 */
export function ingestEvent(deps: Deps, input: EventInput): { event: AgentOSEvent; created: boolean } {
  const definition = deps.registry.eventType(input.domain, input.type);
  if (!definition) throw new HTTPException(400, { message: `模块 ${input.domain} 未定义事件类型 ${input.type}` });

  const at = input.at ?? deps.clock();
  const severity = input.severity ?? definition.severity;
  const count = Math.max(1, Math.floor(input.count ?? 1));
  const payload = input.payload ?? {};
  const title = input.title ?? `${input.source.station ? `${input.source.station} ` : ''}${definition.label}`;
  const summary = input.summary ?? '';
  const dedupeKey =
    input.dedupeKey ??
    [input.domain, input.type, input.source.station ?? '', ...(definition.dedupeFields ?? []).map((f) => String(payload[f] ?? ''))].join(':');

  const duplicate = deps.db
    .prepare(
      `SELECT * FROM events WHERE dedupe_key = ? AND status != 'resolved' AND last_seen_at >= ?
       ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(dedupeKey, addMinutes(at, -DEDUPE_MINUTES).toISOString()) as Row | undefined;

  let id: string;
  if (duplicate) {
    id = String(duplicate.id);
    const merged = { ...parseJson<Record<string, unknown>>(duplicate.payload_json, {}), ...payload };
    deps.db
      .prepare(
        `UPDATE events SET count = count + ?, severity = ?, title = ?, summary = ?, payload_json = ?, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(
        count,
        maxSeverity(duplicate.severity as Severity, severity),
        title,
        summary || String(duplicate.summary),
        JSON.stringify(merged),
        at.toISOString(),
        id,
      );
  } else {
    id = newId('EVT');
    deps.db
      .prepare(
        `INSERT INTO events (id, domain, type, severity, title, summary, payload_json, source_json, dedupe_key, count, status, turn_id, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        id,
        input.domain,
        input.type,
        severity,
        title,
        summary,
        JSON.stringify(payload),
        JSON.stringify(input.source),
        dedupeKey,
        count,
        input.turnId ?? null,
        at.toISOString(),
        at.toISOString(),
      );
  }

  const event = getEvent(deps, id)!;
  deps.bus.publish({ kind: duplicate ? 'event.updated' : 'event.created', event });

  const module = deps.registry.module(input.domain);
  module.onEvent?.(
    { db: deps.db, now: at, emit: (follow) => ingestEvent(deps, { ...follow, at: follow.at ?? at, turnId: follow.turnId ?? input.turnId }) },
    event,
    { created: !duplicate },
  );
  evaluateDomain(deps, input.domain);
  return { event: getEvent(deps, id)!, created: !duplicate };
}

export function listEvents(
  deps: Deps,
  filter: { domains: Domain[]; status?: EventStatus | 'unresolved'; limit?: number },
): AgentOSEvent[] {
  if (filter.domains.length === 0) return [];
  const placeholders = filter.domains.map(() => '?').join(',');
  const params: string[] = [...filter.domains];
  let sql = `SELECT * FROM events WHERE domain IN (${placeholders})`;
  if (filter.status === 'unresolved') sql += ` AND status != 'resolved'`;
  else if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  sql += ` ORDER BY last_seen_at DESC LIMIT ${Math.min(filter.limit ?? 50, 500)}`;
  return (deps.db.prepare(sql).all(...params) as Row[]).map((row) => rowToEvent(deps, row));
}

export function setEventStatus(deps: Deps, id: string, status: EventStatus): AgentOSEvent {
  const event = getEvent(deps, id);
  if (!event) throw new HTTPException(404, { message: '事件不存在' });
  deps.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, id);
  const updated = getEvent(deps, id)!;
  deps.bus.publish({ kind: 'event.updated', event: updated });
  evaluateDomain(deps, event.domain);
  return updated;
}

/** Remove payload fields the role may not see. */
export function redactEvent(deps: Deps, event: AgentOSEvent, role: Role): AgentOSEvent {
  const hidden = deps.registry.eventType(event.domain, event.type)?.hiddenFields?.[role];
  if (!hidden || hidden.length === 0) return event;
  const payload = { ...event.payload };
  for (const field of hidden) if (field in payload) payload[field] = '（无权查看）';
  return { ...event, payload };
}
