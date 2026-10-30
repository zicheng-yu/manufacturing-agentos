import type { DB, Row } from '../../db.ts';

export interface Station {
  id: string;
  zone: string;
  kind: string;
  status: string;
}

export interface StationStats {
  station: string;
  recognitions: number;
  recognitionFailures: number;
  picks: number;
  pickFailures: number;
  placements: number;
  placementInvalid: number;
  avgCycleTime: number | null;
  backlog: number;
}

export interface MetricsInput {
  station: string;
  ts?: string;
  recognitions?: number;
  recognitionFailures?: number;
  picks?: number;
  pickFailures?: number;
  placements?: number;
  placementInvalid?: number;
  cycleTimeS?: number | null;
  backlog?: number;
}

export function listStations(db: DB): Station[] {
  return (db.prepare('SELECT * FROM logistics_stations ORDER BY rowid').all() as Row[]).map((r) => ({
    id: String(r.id),
    zone: String(r.zone),
    kind: String(r.kind),
    status: String(r.status),
  }));
}

export function recordMetrics(db: DB, input: MetricsInput, now: Date): void {
  db.prepare(
    `INSERT INTO logistics_metrics (station_id, ts, recognitions, recognition_failures, picks, pick_failures, placements, placement_invalid, cycle_time_s, backlog)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.station,
    input.ts ?? now.toISOString(),
    input.recognitions ?? 0,
    input.recognitionFailures ?? 0,
    input.picks ?? 0,
    input.pickFailures ?? 0,
    input.placements ?? 0,
    input.placementInvalid ?? 0,
    input.cycleTimeS ?? null,
    input.backlog ?? 0,
  );
}

/**
 * Totals per station over its most recent `readings` reports (the bridge reports every few minutes), so the board
 * stays meaningful however long ago the simulation last ran. Backlog is the latest reading.
 */
export function stationStats(db: DB, readings = 6): StationStats[] {
  return listStations(db).map((s) => {
    const rows = db
      .prepare('SELECT * FROM logistics_metrics WHERE station_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(s.id, readings) as Row[];
    const sum = (field: string) => rows.reduce((acc, r) => acc + Number(r[field] ?? 0), 0);
    const cycles = rows.map((r) => r.cycle_time_s).filter((v): v is number => v !== null && v !== undefined).map(Number);
    return {
      station: s.id,
      recognitions: sum('recognitions'),
      recognitionFailures: sum('recognition_failures'),
      picks: sum('picks'),
      pickFailures: sum('pick_failures'),
      placements: sum('placements'),
      placementInvalid: sum('placement_invalid'),
      avgCycleTime: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
      backlog: rows.length ? Number(rows[0].backlog ?? 0) : 0,
    };
  });
}

/** The station with the lowest pick success in its latest report, if any station picks. */
export function worstStation(stats: StationStats[]): StationStats | null {
  return stats.filter((s) => s.picks > 0).sort((a, b) => (a.picks - a.pickFailures) / a.picks - (b.picks - b.pickFailures) / b.picks)[0] ?? null;
}

export function totals(stats: StationStats[]) {
  const sum = (f: (s: StationStats) => number) => stats.reduce((acc, s) => acc + f(s), 0);
  const cycles = stats.map((s) => s.avgCycleTime).filter((v): v is number => v !== null);
  return {
    picks: sum((s) => s.picks),
    pickFailures: sum((s) => s.pickFailures),
    placements: sum((s) => s.placements),
    placementInvalid: sum((s) => s.placementInvalid),
    recognitions: sum((s) => s.recognitions),
    recognitionFailures: sum((s) => s.recognitionFailures),
    backlog: sum((s) => s.backlog),
    avgCycleTime: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
  };
}

const DISPOSAL: Record<string, string> = {
  grasp_failed: '暂停该工位自动抓取，切换人工辅助；检查夹爪真空度与视觉标定',
  recognition_failed: '清洁相机并检查补光，未识别料箱转人工复核区',
  placement_invalid: '回退该层码放，核对码垛规则与料箱规格是否匹配',
  backlog_high: '改道至备用码垛工位，暂停上游入库节拍',
  station_down: '停机检修，任务改派相邻工位',
};

/** Default handling advice per logistics event type. */
export function disposalFor(type: string): string {
  return DISPOSAL[type] ?? '安排现场人员复核';
}
