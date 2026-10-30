import type { Deps } from '../../core/deps.ts';
import { getEvent, ingestEvent, setEventStatus } from '../../core/events.ts';
import type { Row } from '../../db.ts';
import { qualityDate } from './calendar.ts';
import { isOverdue, listCapa } from './data.ts';

const registered = new WeakSet<Deps>();
const reconciling = new WeakSet<Deps>();

/** Business-state alerts are independent of an individual chat turn. */
export function syncOverdueEvents(deps: Deps): void {
  if (reconciling.has(deps)) return;
  reconciling.add(deps);
  try {
    const now = deps.clock();
    const today = qualityDate(now);
    const capa = listCapa(deps.db);
    const reports = (deps.db.prepare("SELECT id FROM events WHERE domain = 'quality' AND type = 'capa_overdue' AND status != 'resolved' ORDER BY last_seen_at DESC").all() as Row[])
      .map((r) => getEvent(deps, String(r.id))!);
    for (const event of reports) {
      const item = capa.find((c) => c.id === event.payload.capaId);
      // Leave unknown external reports intact; only reconcile known business records.
      if (item && !isOverdue(item, today)) setEventStatus(deps, event.id, 'resolved');
    }
    for (const item of capa.filter((c) => isOverdue(c, today))) {
      const existing = reports.find((e) => e.payload.capaId === item.id);
      const recent = existing && now.getTime() - Date.parse(existing.lastSeenAt) < 13 * 86_400_000;
      if (recent && existing.payload.due === item.due && existing.payload.owner === item.owner && existing.payload.title === item.title) continue;
      ingestEvent(deps, {
        domain: 'quality', type: 'capa_overdue', dedupeKey: existing?.dedupeKey,
        title: `${item.id} 整改逾期`,
        summary: `${item.title}，责任人 ${item.owner}，原定 ${item.due} 完成，当前${item.status}；需督办并核实新的完成计划`,
        payload: { capaId: item.id, complaintId: item.complaintId, title: item.title, owner: item.owner, due: item.due },
        source: { channel: existing?.source.channel === 'seed' ? 'seed' : 'agent', actor: '8D 自动跟踪规则' },
        at: now,
      });
    }
  } finally {
    reconciling.delete(deps);
  }
}

/** Reuse the service's existing minute-by-minute situation evaluation; no extra timers or core hooks. */
export function installQualityTracking(deps: Deps): void {
  if (registered.has(deps)) return;
  registered.add(deps);
  deps.bus.subscribe((message) => {
    if (message.kind === 'situation.updated' && message.situation.domain === 'quality') syncOverdueEvents(deps);
  });
  syncOverdueEvents(deps);
}
