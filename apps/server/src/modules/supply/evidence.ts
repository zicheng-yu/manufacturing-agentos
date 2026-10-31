import type { DB, Row } from '../../db.ts';
import { round } from '../../core/util.ts';

/** Quantity × recorded unit price; 90 days is an analysis filter, not an accounting provision rule. */
export function inventoryExposure(db: DB, minDays = 90) {
  const rows = (db.prepare('SELECT code, name, batch, on_hand, unit_price, stale_days FROM supply_materials ORDER BY code').all() as Row[]).map((r) => ({
    code: String(r.code), name: String(r.name), batch: String(r.batch), days: Number(r.stale_days), value: Number(r.on_hand) * Number(r.unit_price),
  }));
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const stale = rows.filter((r) => r.days >= minDays && r.value > 0).sort((a, b) => b.value - a.value);
  const value = stale.reduce((sum, r) => sum + r.value, 0);
  return { total: round(total, 2), value: round(value, 2), share: total > 0 ? value / total : null, count: rows.length, minDays, rows: stale };
}
