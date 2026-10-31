import { SEVERITY_TO_LEVEL, type AgentOSEvent, type Domain, type Signal, type Situation } from '@agentos/shared';
import { parseJson, type Row } from '../db.ts';
import type { Deps } from './deps.ts';
import { rowToEvent, severityRank } from './events.ts';
import type { SignalRule } from './module.ts';
import { addMinutes, shortHash } from './util.ts';

const ALL = '__all__';
const evaluating = new WeakMap<Deps, Set<Domain>>();

export function rowToSignal(row: Row): Signal {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    domain: row.domain as Domain,
    severity: row.severity as Signal['severity'],
    title: String(row.title),
    summary: String(row.summary),
    eventIds: parseJson(row.event_ids_json, []),
    count: Number(row.count),
    status: row.status as Signal['status'],
    firstAt: String(row.first_at),
    lastAt: String(row.last_at),
    updatedAt: String(row.updated_at),
  };
}

export function listSignals(deps: Deps, domains: Domain[], status: Signal['status'] = 'active'): Signal[] {
  if (domains.length === 0) return [];
  const placeholders = domains.map(() => '?').join(',');
  const rows = deps.db
    .prepare(`SELECT * FROM signals WHERE domain IN (${placeholders}) AND status = ? ORDER BY last_at DESC`)
    .all(...domains, status) as Row[];
  return rows.map(rowToSignal);
}

export function signalEvents(deps: Deps, signal: Signal): AgentOSEvent[] {
  if (signal.eventIds.length === 0) return [];
  const placeholders = signal.eventIds.map(() => '?').join(',');
  const rows = deps.db.prepare(`SELECT * FROM events WHERE id IN (${placeholders})`).all(...signal.eventIds) as Row[];
  return rows.map((row) => rowToEvent(deps, row));
}

function matchingEvents(deps: Deps, domain: Domain, rule: SignalRule, now: Date): AgentOSEvent[] {
  const placeholders = rule.types.map(() => '?').join(',');
  const rows = deps.db
    .prepare(
      `SELECT * FROM events WHERE domain = ? AND type IN (${placeholders}) AND status != 'resolved' AND last_seen_at >= ?
       ORDER BY last_seen_at ASC`,
    )
    .all(domain, ...rule.types, addMinutes(now, -rule.windowMinutes).toISOString()) as Row[];
  return rows.map((row) => rowToEvent(deps, row));
}

/** Recompute the domain's signals from its recent events, then its situation card. Publishes only changes. */
export function evaluateDomain(deps: Deps, domain: Domain): void {
  const active = evaluating.get(deps) ?? new Set<Domain>();
  if (active.has(domain)) return;
  evaluating.set(deps, active);
  active.add(domain);
  try {
    // Reconciliation may ingest/resolve events. Defer their nested evaluations until it finishes.
    deps.registry.module(domain).beforeEvaluate?.(deps);
    evaluateDomainState(deps, domain);
  } finally {
    active.delete(domain);
  }
}

function evaluateDomainState(deps: Deps, domain: Domain): void {
  const module = deps.registry.module(domain);
  const now = deps.clock();
  const nowIso = now.toISOString();

  for (const rule of module.signalRules) {
    const groups = new Map<string, AgentOSEvent[]>();
    for (const event of matchingEvents(deps, domain, rule, now)) {
      const key = rule.groupBy ? rule.groupBy(event) : ALL;
      if (key === null) continue;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }

    const activeIds = new Set<string>();
    for (const [key, events] of groups) {
      const count = events.reduce((sum, e) => sum + e.count, 0);
      if (count < rule.threshold) continue;
      const id = key === ALL ? `SIG-${rule.id}` : `SIG-${rule.id}-${shortHash(key)}`;
      activeIds.add(id);
      const { title, summary } = rule.describe(events, key === ALL ? null : key);
      const eventIds = events.map((e) => e.id);
      const existing = deps.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Row | undefined;
      const wasActive = existing?.status === 'active';
      const unchanged =
        wasActive && Number(existing!.count) === count && existing!.event_ids_json === JSON.stringify(eventIds) && existing!.summary === summary;
      if (unchanged) continue;

      deps.db
        .prepare(
          `INSERT INTO signals (id, rule_id, domain, severity, title, summary, event_ids_json, count, status, first_at, last_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, title = excluded.title, summary = excluded.summary,
             event_ids_json = excluded.event_ids_json, count = excluded.count, status = 'active',
             first_at = CASE WHEN signals.status = 'active' THEN signals.first_at ELSE excluded.first_at END,
             last_at = excluded.last_at, updated_at = excluded.updated_at`,
        )
        .run(id, rule.id, domain, rule.severity, title, summary, JSON.stringify(eventIds), count, events[0].createdAt, events.at(-1)!.lastSeenAt, nowIso);
      const signal = rowToSignal(deps.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Row);
      deps.bus.publish({ kind: wasActive ? 'signal.updated' : 'signal.raised', signal });
    }

    const stale = deps.db
      .prepare(`SELECT * FROM signals WHERE domain = ? AND rule_id = ? AND status = 'active'`)
      .all(domain, rule.id) as Row[];
    for (const row of stale) {
      if (activeIds.has(String(row.id))) continue;
      deps.db.prepare(`UPDATE signals SET status = 'cleared', updated_at = ? WHERE id = ?`).run(nowIso, String(row.id));
      deps.bus.publish({ kind: 'signal.cleared', signal: rowToSignal({ ...row, status: 'cleared', updated_at: nowIso }) });
    }
  }

  const situation = computeSituation(deps, domain);
  const serialized = JSON.stringify(situation);
  if (deps.situationCache.get(domain) !== serialized) {
    deps.situationCache.set(domain, serialized);
    deps.bus.publish({ kind: 'situation.updated', situation });
  }
}

export function computeSituation(deps: Deps, domain: Domain): Situation {
  const module = deps.registry.module(domain);
  const signals = listSignals(deps, [domain]).sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const draft = module.situation({ db: deps.db, now: deps.clock(), signals });
  const level = signals[0] ? SEVERITY_TO_LEVEL[signals[0].severity] : 'normal';
  return { domain, ...draft, level, signalIds: signals.map((s) => s.id) };
}
