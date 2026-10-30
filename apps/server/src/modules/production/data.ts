import type { DB, Row } from '../../db.ts';
import { addDays, isoDate, round } from '../../core/util.ts';

/** ISO 10816 class II zone boundaries for spindle vibration RMS, mm/s. */
export const VIBRATION_WARN = 2.8;
export const VIBRATION_ALARM = 4.5;
/** Plant OEE target used when no regulation sets one (marked as an assumption wherever shown). */
export const OEE_TARGET = 75;

export interface Equipment {
  id: string;
  name: string;
  line: string;
  commissioned: string;
  taktSeconds: number;
  maintenanceCycleDays: number;
  keyParts: string;
}

export interface Reading {
  equipmentId: string;
  ts: string;
  vibration: number | null;
  temperature: number | null;
  current: number | null;
  rpm: number | null;
  load: number | null;
}

export interface Repair {
  id: string;
  equipmentId: string;
  occurredAt: string;
  symptom: string;
  cause: string;
  downtimeMin: number;
  cost: number;
  lostOutput: number;
  action: string;
}

export function listEquipment(db: DB): Equipment[] {
  return (db.prepare('SELECT * FROM production_equipment ORDER BY id').all() as Row[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    line: String(r.line),
    commissioned: String(r.commissioned),
    taktSeconds: Number(r.takt_seconds),
    maintenanceCycleDays: Number(r.maintenance_cycle_days),
    keyParts: String(r.key_parts),
  }));
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function readings(db: DB, equipmentId: string): Reading[] {
  return (db.prepare('SELECT * FROM production_sensors WHERE equipment_id = ? ORDER BY ts').all(equipmentId) as Row[]).map((r) => ({
    equipmentId: String(r.equipment_id),
    ts: String(r.ts),
    vibration: n(r.vibration),
    temperature: n(r.temperature),
    current: n(r.current),
    rpm: n(r.rpm),
    load: n(r.load),
  }));
}

export function listRepairs(db: DB): Repair[] {
  return (db.prepare('SELECT * FROM production_repairs ORDER BY occurred_at').all() as Row[]).map((r) => ({
    id: String(r.id),
    equipmentId: String(r.equipment_id),
    occurredAt: String(r.occurred_at),
    symptom: String(r.symptom),
    cause: String(r.cause),
    downtimeMin: Number(r.downtime_min),
    cost: Number(r.cost),
    lostOutput: Number(r.lost_output),
    action: String(r.action),
  }));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Health {
  equipment: Equipment;
  readings: number;
  missing: number;
  baseline: number;
  latest: Reading | null;
  alarms: Reading[];
  recentAlarms: Reading[];
  warnings: number;
  lastRepair: Repair | null;
  /** For each repair: days between the last vibration alarm before it (within 14 days) and the failure. */
  leadDays: { repair: Repair; days: number }[];
  status: '正常' | '关注' | '告警';
}

/**
 * Per-equipment condition from the hourly sensor series: a robust baseline (median), readings past the ISO alarm
 * line, gaps in the series, and how far ahead alarms preceded the recorded failures.
 */
export function equipmentHealth(db: DB, recentHours = 72): Health[] {
  const repairs = listRepairs(db);
  return listEquipment(db).map((equipment) => {
    const series = readings(db, equipment.id);
    const values = series.map((r) => r.vibration).filter((v): v is number => v !== null);
    const alarms = series.filter((r) => (r.vibration ?? 0) >= VIBRATION_ALARM);
    const recent = series.slice(-recentHours);
    const recentAlarms = recent.filter((r) => (r.vibration ?? 0) >= VIBRATION_ALARM);
    const mine = repairs.filter((r) => r.equipmentId === equipment.id);
    const leadDays = mine
      .map((repair) => {
        const before = alarms.filter((a) => a.ts <= repair.occurredAt && Date.parse(repair.occurredAt) - Date.parse(a.ts) <= 14 * 86_400_000);
        const last = before.at(-1);
        return last ? { repair, days: round((Date.parse(repair.occurredAt) - Date.parse(last.ts)) / 86_400_000, 1) } : null;
      })
      .filter((x): x is { repair: Repair; days: number } => x !== null);
    const latest = [...series].reverse().find((r) => r.vibration !== null) ?? null;
    return {
      equipment,
      readings: series.length,
      missing: series.length - values.length,
      baseline: round(median(values), 2),
      latest,
      alarms,
      recentAlarms,
      warnings: recent.filter((r) => (r.vibration ?? 0) >= VIBRATION_WARN && (r.vibration ?? 0) < VIBRATION_ALARM).length,
      lastRepair: mine.at(-1) ?? null,
      leadDays,
      status: recentAlarms.length ? '告警' : (latest?.vibration ?? 0) >= VIBRATION_WARN ? '关注' : '正常',
    };
  });
}

export interface OeeDay {
  date: string;
  line: string;
  plannedMin: number;
  downtimeMin: number;
  availability: number;
  performance: number;
  quality: number;
  oee: number;
  topLoss: string;
}

export function listOee(db: DB): OeeDay[] {
  return (db.prepare('SELECT * FROM production_oee ORDER BY date, line').all() as Row[]).map((r) => ({
    date: String(r.date),
    line: String(r.line),
    plannedMin: Number(r.planned_min),
    downtimeMin: Number(r.downtime_min),
    availability: Number(r.availability),
    performance: Number(r.performance),
    quality: Number(r.quality),
    oee: Number(r.oee),
    topLoss: String(r.top_loss),
  }));
}

export interface LineOee {
  line: string;
  days: number;
  oee: number;
  availability: number;
  performance: number;
  quality: number;
  /** The weakest of the three factors, which is where the loss sits. */
  weakest: '时间开动率' | '性能开动率' | '合格品率';
  losses: { reason: string; days: number; downtimeMin: number }[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** OEE over the last `days` recorded days per line, split into A × P × Q and ranked loss reasons. */
export function lineOee(db: DB, days = 7): LineOee[] {
  const all = listOee(db);
  const dates = [...new Set(all.map((d) => d.date))].sort().slice(-days);
  const window = all.filter((d) => dates.includes(d.date));
  const lines = [...new Set(window.map((d) => d.line))].sort();
  return lines.map((line) => {
    const rows = window.filter((d) => d.line === line);
    const losses = new Map<string, { days: number; downtimeMin: number }>();
    for (const r of rows) {
      const l = losses.get(r.topLoss) ?? { days: 0, downtimeMin: 0 };
      losses.set(r.topLoss, { days: l.days + 1, downtimeMin: l.downtimeMin + r.downtimeMin });
    }
    const a = avg(rows.map((r) => r.availability));
    const p = avg(rows.map((r) => r.performance));
    const q = avg(rows.map((r) => r.quality));
    const factors = [
      ['时间开动率', a],
      ['性能开动率', p],
      ['合格品率', q],
    ] as const;
    return {
      line,
      days: rows.length,
      oee: round(avg(rows.map((r) => r.oee)), 1),
      availability: round(a, 1),
      performance: round(p, 1),
      quality: round(q, 1),
      weakest: [...factors].sort((x, y) => x[1] - y[1])[0][0],
      losses: [...losses].map(([reason, v]) => ({ reason, ...v })).sort((x, y) => y.downtimeMin - x.downtimeMin),
    };
  });
}

export function plantLosses(db: DB, days = 7): { reason: string; downtimeMin: number; days: number }[] {
  const merged = new Map<string, { downtimeMin: number; days: number }>();
  for (const line of lineOee(db, days)) {
    for (const l of line.losses) {
      const m = merged.get(l.reason) ?? { downtimeMin: 0, days: 0 };
      merged.set(l.reason, { downtimeMin: m.downtimeMin + l.downtimeMin, days: m.days + l.days });
    }
  }
  return [...merged].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.downtimeMin - a.downtimeMin);
}

export interface WorkOrder {
  id: string;
  product: string;
  qty: number;
  tier: string;
  due: string;
  unitSeconds: number;
  lines: string[];
  priority: number;
}

export interface Line {
  id: string;
  hours: number;
  staff: number;
  bottleneck: string;
  yieldBaseline: number;
  maxDaily: number;
}

export function listOrders(db: DB): WorkOrder[] {
  return (db.prepare('SELECT * FROM production_orders ORDER BY due').all() as Row[]).map((r) => ({
    id: String(r.id),
    product: String(r.product),
    qty: Number(r.qty),
    tier: String(r.tier),
    due: String(r.due),
    unitSeconds: Number(r.unit_seconds),
    lines: String(r.lines).split(',').map((s) => s.trim()).filter(Boolean),
    priority: Number(r.priority),
  }));
}

export function listLines(db: DB): Line[] {
  return (db.prepare('SELECT * FROM production_lines ORDER BY id').all() as Row[]).map((r) => ({
    id: String(r.id),
    hours: Number(r.hours),
    staff: Number(r.staff),
    bottleneck: String(r.bottleneck),
    yieldBaseline: Number(r.yield_baseline),
    maxDaily: Number(r.max_daily),
  }));
}

export function changeoverMinutes(db: DB, from: string | null, to: string): number {
  if (!from || from === to) return 0;
  const row = db.prepare('SELECT minutes FROM production_changeover WHERE from_product = ? AND to_product = ?').get(from, to) as Row | undefined;
  return row ? Number(row.minutes) : 0;
}

export interface Scheduled {
  order: WorkOrder;
  line: string;
  start: string;
  finish: string;
  changeoverMin: number;
  slackDays: number;
  late: boolean;
}

/**
 * Greedy finite-capacity schedule from tomorrow: highest priority (then earliest due) first, each order to the
 * feasible line that finishes it soonest. Daily output = min(max daily capacity, hours × 3600 / unit seconds × OEE).
 */
export function schedule(db: DB, now: Date): { rows: Scheduled[]; unplaceable: WorkOrder[] } {
  const lines = new Map(listLines(db).map((l) => [l.id, l]));
  const oee = new Map(lineOee(db).map((l) => [l.line, l.oee / 100]));
  const plantOee = avg([...oee.values()]) || 0.7;
  const state = new Map([...lines.keys()].map((id) => [id, { day: 0, last: null as string | null }]));
  const start = addDays(new Date(isoDate(now) + 'T00:00:00Z'), 1);
  const rows: Scheduled[] = [];
  const unplaceable: WorkOrder[] = [];
  const orders = [...listOrders(db)].sort((a, b) => b.priority - a.priority || a.due.localeCompare(b.due));
  for (const order of orders) {
    let best: { line: string; begin: number; end: number; changeover: number } | null = null;
    for (const lineId of order.lines) {
      const line = lines.get(lineId);
      const s = state.get(lineId);
      if (!line || !s) continue;
      const daily = Math.min(line.maxDaily, ((line.hours * 3600) / order.unitSeconds) * (oee.get(lineId) ?? plantOee));
      const changeover = changeoverMinutes(db, s.last, order.product);
      const begin = s.day + changeover / (line.hours * 60);
      const end = begin + order.qty / daily;
      if (!best || end < best.end) best = { line: lineId, begin, end, changeover };
    }
    if (!best) {
      unplaceable.push(order);
      continue;
    }
    state.set(best.line, { day: best.end, last: order.product });
    const finish = isoDate(addDays(start, Math.ceil(best.end) - 1));
    const slackDays = Math.round((Date.parse(order.due) - Date.parse(finish)) / 86_400_000);
    rows.push({
      order,
      line: best.line,
      start: isoDate(addDays(start, Math.floor(best.begin))),
      finish,
      changeoverMin: best.changeover,
      slackDays,
      late: slackDays < 0,
    });
  }
  return { rows, unplaceable };
}
