import type { DB } from '../../db.ts';
import { round } from '../../core/util.ts';
import { listRepairs, readings, PRECURSOR_HOURS, VIBRATION_WARN, parseStamp as stamp, warningTrigger } from './data.ts';

/** Retrospective coverage, not predictive accuracy: replay the actual 3-in-24h warning rule before each repair. */
export function confirmedPrecursors(db: DB) {
  return listRepairs(db).map((repair) => {
    const failed = stamp(repair.occurredAt);
    const window = readings(db, repair.equipmentId).filter((r) => {
      const time = stamp(r.ts);
      return time < failed && failed - time <= PRECURSOR_HOURS * 3600_000 && r.vibration !== null && r.vibration >= VIBRATION_WARN;
    });
    const confirmed = warningTrigger(window);
    return { repair, first: window[0]?.ts ?? null, confirmedAt: confirmed?.ts ?? null, hoursAhead: confirmed ? round((failed - stamp(confirmed.ts)) / 3600_000, 1) : null };
  });
}
