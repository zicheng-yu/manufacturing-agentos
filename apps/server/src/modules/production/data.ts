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
  /** For each repair: when vibration first entered the warning zone in the 72 hours before it, and how often. */
  precursors: Precursor[];
  status: '正常' | '关注' | '告警';
}

export interface Precursor {
  repair: Repair;
  firstWarning: string;
  confirmedAt: string;
  hoursAhead: number;
  warningReadings: number;
}

/** Warning-zone readings within this many hours before a failure count as its precursor. */
export const PRECURSOR_HOURS = 72;
/** Readings in the warning zone within 24 hours that make a live precursor alert. */
export const PRECURSOR_READINGS = 3;

export function parseStamp(ts: string): number {
  const iso = ts.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}+08:00`);
}

/** First timestamp when 3 distinct observations in a trailing 24h window meet the warning threshold. */
export function warningTrigger(series: Reading[]): Reading | null {
  const points = [...new Map(series.filter((r) => r.vibration !== null && r.vibration >= VIBRATION_WARN).map((r) => [parseStamp(r.ts), r])).values()]
    .filter((r) => Number.isFinite(parseStamp(r.ts))).sort((a, b) => parseStamp(a.ts) - parseStamp(b.ts));
  let start = 0;
  for (let i = 0; i < points.length; i++) {
    while (parseStamp(points[i].ts) - parseStamp(points[start].ts) > 24 * 3600_000) start++;
    if (i - start + 1 >= PRECURSOR_READINGS) return points[i];
  }
  return null;
}

/** Rolling rule evaluated with information available at that instant; no future repair labels are used. */
function warningTriggers(input: Reading[]): Reading[] {
  const series = [...new Map(input.map(r => [parseStamp(r.ts), r])).values()].filter(r => Number.isFinite(parseStamp(r.ts))).sort((a,b) => parseStamp(a.ts)-parseStamp(b.ts));
  const triggers: Reading[] = [];
  let active = false;
  let left = 0;
  for (let i = 0; i < series.length; i++) {
    const t = parseStamp(series[i].ts);
    while (left < i && t - parseStamp(series[left].ts) > 24 * 3600_000) left++;
    const count = series.slice(left, i + 1).filter(r => r.vibration !== null && r.vibration >= VIBRATION_WARN).length;
    const next = count >= PRECURSOR_READINGS;
    if (next && !active) triggers.push(series[i]);
    active = next;
  }
  return triggers;
}

export function warningAudit(db: DB) {
  const repairs = listRepairs(db);
  let mature = 0, unmatched = 0, censored = 0;
  const dates: string[] = [];
  for (const e of listEquipment(db)) {
    const series = readings(db, e.id);
    if (!series.length) continue;
    dates.push(series[0].ts, series.at(-1)!.ts);
    const end = parseStamp(series.at(-1)!.ts);
    for (const trigger of warningTriggers(series)) {
      const t = parseStamp(trigger.ts);
      if (end - t < PRECURSOR_HOURS * 3600_000) { censored++; continue; }
      mature++;
      if (!repairs.some(r => r.equipmentId === e.id && parseStamp(r.occurredAt) > t && parseStamp(r.occurredAt) - t <= PRECURSOR_HOURS * 3600_000)) unmatched++;
    }
  }
  dates.sort();
  return { mature, unmatched, censored, window: `${dates[0] ?? '无读数'} 至 ${dates.at(-1) ?? '无读数'}；末尾随访不足72小时的 ${censored} 次告警不计入未匹配率` };
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
    const precursors = mine
      .map((repair): Precursor | null => {
        const failedAt = parseStamp(repair.occurredAt);
        const window = series.filter((r) => {
          const t = parseStamp(r.ts);
          return t < failedAt && failedAt - t <= PRECURSOR_HOURS * 3600_000 && (r.vibration ?? 0) >= VIBRATION_WARN;
        });
        const confirmed = warningTrigger(window);
        if (!confirmed) return null;
        return {
          repair,
          firstWarning: window[0].ts,
          confirmedAt: confirmed.ts,
          hoursAhead: round((failedAt - parseStamp(confirmed.ts)) / 3600_000, 1),
          warningReadings: window.length,
        };
      })
      .filter((x): x is Precursor => x !== null);
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
      precursors,
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

export type Strategy = 'priority' | 'due' | 'slack';
export const STRATEGY_LABEL: Record<Strategy, string> = { priority: '优先级优先', due: '交期优先', slack: '加权松弛优先' };
/** Lateness weight by customer tier: a strategic customer's late day counts three times a general one's. */
const TIER_WEIGHT: Record<string, number> = { 战略客户: 3, 重点客户: 2, 一般客户: 1 };

export interface Plan {
  strategy: Strategy;
  rows: Scheduled[];
  unplaceable: WorkOrder[];
  late: number;
  /** Σ late days × tier weight. */
  weightedLateness: number;
}

function order(orders: WorkOrder[], strategy: Strategy, now: Date): WorkOrder[] {
  const daysLeft = (o: WorkOrder) => (Date.parse(o.due) - now.getTime()) / 86_400_000;
  const sorted = [...orders];
  if (strategy === 'priority') sorted.sort((a, b) => b.priority - a.priority || a.due.localeCompare(b.due));
  else if (strategy === 'due') sorted.sort((a, b) => a.due.localeCompare(b.due) || b.priority - a.priority);
  else sorted.sort((a, b) => daysLeft(a) / (TIER_WEIGHT[a.tier] ?? 1) - daysLeft(b) / (TIER_WEIGHT[b.tier] ?? 1));
  return sorted;
}

/**
 * Finite-capacity schedule from tomorrow: orders in the strategy's sequence, each to the feasible line that
 * finishes it soonest. Daily output = min(max daily capacity, hours × 3600 / unit seconds × OEE).
 */
/** `hours` overrides each line's daily hours, e.g. an overtime scenario. */
export function planWith(db: DB, now: Date, strategy: Strategy, hours?: (line: Line) => number): Plan {
  const lines = new Map(listLines(db).map((l) => [l.id, l]));
  const oee = new Map(lineOee(db).map((l) => [l.line, l.oee / 100]));
  const plantOee = avg([...oee.values()]) || 0.7;
  const state = new Map([...lines.keys()].map((id) => [id, { day: 0, last: null as string | null }]));
  const start = addDays(new Date(isoDate(now) + 'T00:00:00Z'), 1);
  const rows: Scheduled[] = [];
  const unplaceable: WorkOrder[] = [];
  for (const o of order(listOrders(db), strategy, now)) {
    let best: { line: string; begin: number; end: number; changeover: number } | null = null;
    for (const lineId of o.lines) {
      const line = lines.get(lineId);
      const s = state.get(lineId);
      if (!line || !s) continue;
      const lineHours = hours?.(line) ?? line.hours;
      const daily = Math.min(line.maxDaily, ((lineHours * 3600) / o.unitSeconds) * (oee.get(lineId) ?? plantOee));
      const changeover = changeoverMinutes(db, s.last, o.product);
      const begin = s.day + changeover / (lineHours * 60);
      const end = begin + o.qty / daily;
      if (!best || end < best.end) best = { line: lineId, begin, end, changeover };
    }
    if (!best) {
      unplaceable.push(o);
      continue;
    }
    state.set(best.line, { day: best.end, last: o.product });
    const finish = isoDate(addDays(start, Math.ceil(best.end) - 1));
    const slackDays = Math.round((Date.parse(o.due) - Date.parse(finish)) / 86_400_000);
    rows.push({ order: o, line: best.line, start: isoDate(addDays(start, Math.floor(best.begin))), finish, changeoverMin: best.changeover, slackDays, late: slackDays < 0 });
  }
  const late = rows.filter((r) => r.late);
  return {
    strategy,
    rows,
    unplaceable,
    late: late.length,
    weightedLateness: late.reduce((s, r) => s + -r.slackDays * (TIER_WEIGHT[r.order.tier] ?? 1), 0),
  };
}

/** Try each sequencing strategy and keep the one with the least tier-weighted lateness. */
export function compareStrategies(db: DB, now: Date): Plan[] {
  return (['priority', 'due', 'slack'] as Strategy[]).map((s) => planWith(db, now, s)).sort((a, b) => a.weightedLateness - b.weightedLateness || a.late - b.late);
}

/** Best strategy again with every line running 24 hours a day (still capped at its maximum daily output). */
export function overtimePlan(db: DB, now: Date): Plan {
  return (['priority', 'due', 'slack'] as Strategy[])
    .map((s) => planWith(db, now, s, () => 24))
    .sort((a, b) => a.weightedLateness - b.weightedLateness || a.late - b.late)[0];
}

export function schedule(db: DB, now: Date): Plan {
  return compareStrategies(db, now)[0];
}
