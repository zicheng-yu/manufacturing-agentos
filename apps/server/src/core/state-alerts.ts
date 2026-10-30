import type { Domain } from '@agentos/shared';
import type { Row } from '../db.ts';
import type { Deps } from './deps.ts';
import { getEvent, ingestEvent, setEventStatus, type EventInput } from './events.ts';

export interface StateAlert {
  /** Identifies the condition, e.g. an equipment id or "plant". */
  key: string;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  severity?: EventInput['severity'];
  station?: string;
}

const REFRESH_MS = 6 * 3600_000;

/**
 * Keep one open event per condition that business data says is true right now, and resolve the ones that no
 * longer hold. Meant for a module's beforeEvaluate: unchanged conditions are left alone, so nothing is re-published.
 */
export function syncStateAlerts(deps: Deps, domain: Domain, type: string, alerts: StateAlert[], actor: string): void {
  const now = deps.clock();
  const open = (
    deps.db
      .prepare(`SELECT id FROM events WHERE domain = ? AND type = ? AND status != 'resolved'`)
      .all(domain, type) as Row[]
  ).map((r) => getEvent(deps, String(r.id))!);
  const keyOf = (payload: Record<string, unknown>) => String(payload.alertKey ?? '');

  for (const event of open) {
    // Only reconcile alerts this rule raised; reports from the bridge or people stay until someone resolves them.
    if (event.payload.alertKey !== undefined && !alerts.some((a) => a.key === keyOf(event.payload))) {
      setEventStatus(deps, event.id, 'resolved');
    }
  }
  for (const alert of alerts) {
    const existing = open.find((e) => keyOf(e.payload) === alert.key);
    if (existing && existing.summary === alert.summary && now.getTime() - Date.parse(existing.lastSeenAt) < REFRESH_MS) continue;
    ingestEvent(deps, {
      domain,
      type,
      severity: alert.severity,
      title: alert.title,
      summary: alert.summary,
      dedupeKey: `${domain}:${type}:${alert.key}`,
      payload: { ...alert.payload, alertKey: alert.key },
      source: { channel: 'manual', actor, station: alert.station },
      at: now,
    });
  }
}
