import type { DB } from '../../db.ts';
import { equipmentHealth, listRepairs } from './data.ts';

/** Retrospective coverage, not predictive accuracy: replay the actual 3-in-24h warning rule before each repair. */
export function confirmedPrecursors(db: DB) {
  const precursors = new Map(equipmentHealth(db).flatMap(h => h.precursors).map(p => [p.repair.id, p]));
  return listRepairs(db).map((repair) => {
    const p = precursors.get(repair.id);
    return { repair, first: p?.firstWarning ?? null, confirmedAt: p?.confirmedAt ?? null, hoursAhead: p?.hoursAhead ?? null };
  });
}
