import type { DB, Row } from '../../db.ts';
import { round } from '../../core/util.ts';

/** Violation types that can kill or maim; these stay on the chairman's desk until closed. */
export const HIGH_RISK = ['违规动火', '未挂牌上锁LOTO', '叉车超速', '违规穿越警戒线'];
/** Statuses that still need someone to act. */
export const OPEN_STATUSES = ['待复核', '已确认整改'];

export interface EnergyRow {
  date: string;
  hour: string;
  workshop: string;
  period: string;
  price: number;
  kwh: number;
  air: number;
  output: number;
  unitEnergy: number | null;
  carbon: number;
}

export interface SafetyEvent {
  id: string;
  ts: string;
  camera: string;
  type: string;
  confidence: number;
  falseAlarm: boolean;
  status: string;
  closureHours: number | null;
}

export function listEnergy(db: DB): EnergyRow[] {
  return (db.prepare('SELECT * FROM ehs_energy ORDER BY date, hour').all() as Row[]).map((r) => ({
    date: String(r.date),
    hour: String(r.hour),
    workshop: String(r.workshop),
    period: String(r.period),
    price: Number(r.price),
    kwh: Number(r.kwh),
    air: Number(r.air),
    output: Number(r.output),
    unitEnergy: r.unit_energy === null ? null : Number(r.unit_energy),
    carbon: Number(r.carbon),
  }));
}

export function listSafety(db: DB): SafetyEvent[] {
  return (db.prepare('SELECT * FROM ehs_events ORDER BY ts DESC').all() as Row[]).map((r) => ({
    id: String(r.id),
    ts: String(r.ts),
    camera: String(r.camera),
    type: String(r.type),
    confidence: Number(r.confidence),
    falseAlarm: Number(r.false_alarm) === 1,
    status: String(r.status),
    closureHours: r.closure_hours === null ? null : Number(r.closure_hours),
  }));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface EnergySummary {
  kwh: number;
  cost: number;
  carbonTons: number;
  peakShare: number;
  prices: Record<string, number>;
  byWorkshop: { workshop: string; kwh: number; output: number; unitEnergy: number; peakShare: number; cost: number }[];
  /** Hours whose unit energy is over twice the workshop median: idle running or a metering spike. */
  anomalies: EnergyRow[];
  /** Saving if 20% of peak-period consumption moved to the valley tariff. */
  shiftSaving: number;
}

export function energySummary(db: DB): EnergySummary {
  const rows = listEnergy(db);
  const prices: Record<string, number> = {};
  for (const r of rows) prices[r.period] = r.price;
  const kwh = sum(rows.map((r) => r.kwh));
  const peak = sum(rows.filter((r) => r.period === '峰').map((r) => r.kwh));
  const workshops = [...new Set(rows.map((r) => r.workshop))];
  const anomalies: EnergyRow[] = [];
  const byWorkshop = workshops.map((w) => {
    const mine = rows.filter((r) => r.workshop === w);
    const units = mine.map((r) => r.unitEnergy).filter((u): u is number => u !== null && u > 0).sort((a, b) => a - b);
    const median = units[Math.floor(units.length / 2)] ?? 0;
    anomalies.push(...mine.filter((r) => r.unitEnergy !== null && median > 0 && r.unitEnergy > median * 2));
    const wk = sum(mine.map((r) => r.kwh));
    const out = sum(mine.map((r) => r.output));
    return {
      workshop: w,
      kwh: round(wk, 0),
      output: out,
      unitEnergy: out ? round(wk / out, 3) : 0,
      peakShare: wk ? round(sum(mine.filter((r) => r.period === '峰').map((r) => r.kwh)) / wk, 3) : 0,
      cost: round(sum(mine.map((r) => r.kwh * r.price)), 0),
    };
  });
  return {
    kwh: round(kwh, 0),
    cost: round(sum(rows.map((r) => r.kwh * r.price)), 0),
    carbonTons: round(sum(rows.map((r) => r.carbon)) / 1000, 1),
    peakShare: kwh ? round(peak / kwh, 3) : 0,
    prices,
    byWorkshop,
    anomalies: anomalies.sort((a, b) => (b.unitEnergy ?? 0) - (a.unitEnergy ?? 0)),
    shiftSaving: round(peak * 0.2 * ((prices['峰'] ?? 0) - (prices['谷'] ?? 0)), 0),
  };
}

export interface SafetySummary {
  total: number;
  falseAlarmRate: number;
  byType: { type: string; count: number; open: number }[];
  byCamera: { camera: string; count: number }[];
  pendingReview: SafetyEvent[];
  openHighRisk: SafetyEvent[];
  avgClosureHours: number | null;
}

export function safetySummary(db: DB): SafetySummary {
  const events = listSafety(db);
  const real = events.filter((e) => !e.falseAlarm);
  const types = new Map<string, { count: number; open: number }>();
  for (const e of real) {
    const t = types.get(e.type) ?? { count: 0, open: 0 };
    types.set(e.type, { count: t.count + 1, open: t.open + (OPEN_STATUSES.includes(e.status) ? 1 : 0) });
  }
  const cameras = new Map<string, number>();
  for (const e of real) cameras.set(e.camera, (cameras.get(e.camera) ?? 0) + 1);
  const closed = real.filter((e) => e.status === '已闭环' && e.closureHours !== null).map((e) => e.closureHours!);
  return {
    total: events.length,
    falseAlarmRate: events.length ? round(events.filter((e) => e.falseAlarm).length / events.length, 3) : 0,
    byType: [...types].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count),
    byCamera: [...cameras].map(([camera, count]) => ({ camera, count })).sort((a, b) => b.count - a.count),
    pendingReview: events.filter((e) => e.status === '待复核'),
    openHighRisk: real.filter((e) => HIGH_RISK.includes(e.type) && OPEN_STATUSES.includes(e.status)),
    avgClosureHours: closed.length ? round(sum(closed) / closed.length, 1) : null,
  };
}
