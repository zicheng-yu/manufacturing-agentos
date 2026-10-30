import type { EventInput } from '../../core/events.ts';
import type { ModuleCtx } from '../../core/module.ts';
import { addMinutes } from '../../core/util.ts';
import { recordMetrics } from './data.ts';

const STATIONS = [
  ['识别-01', '入库口', '视觉识别'],
  ['抓取-01', '入库口', '机械臂抓取'],
  ['码垛-01', '码垛区', '码垛机器人'],
  ['码垛-02', '码垛区', '码垛机器人'],
  ['入库暂存区', '缓冲区', '暂存'],
] as const;

const BIN_TYPES = [
  ['KLT-4314', '小型 KLT 料箱', '400×300×147', 6, 'A 区'],
  ['KLT-6414', '中型 KLT 料箱', '600×400×147', 5, 'B 区'],
  ['KLT-6428', '高型 KLT 料箱', '600×400×280', 3, 'C 区'],
  ['GLT-1208', '大型 GLT 托盘箱', '1200×800×600', 2, 'D 区'],
] as const;

export function seedLogistics({ db, now }: ModuleCtx): void {
  const station = db.prepare('INSERT INTO logistics_stations (id, zone, kind, status) VALUES (?, ?, ?, ?)');
  for (const [id, zone, kind] of STATIONS) station.run(id, zone, kind, '运行');
  const bin = db.prepare('INSERT INTO logistics_bin_types (code, name, size, max_stack, target_zone) VALUES (?, ?, ?, ?, ?)');
  for (const b of BIN_TYPES) bin.run(...b);

  // Two hours of healthy readings, one per station every 10 minutes. Deterministic jitter.
  for (let slot = 12; slot >= 1; slot--) {
    const ts = addMinutes(now, -slot * 10).toISOString();
    const jitter = (slot * 7) % 5;
    recordMetrics(db, { station: '识别-01', ts, recognitions: 58 + jitter, recognitionFailures: slot % 6 === 0 ? 1 : 0, cycleTimeS: 9.6 + jitter / 10 }, now);
    recordMetrics(db, { station: '抓取-01', ts, picks: 57 + jitter, pickFailures: slot % 5 === 0 ? 1 : 0, cycleTimeS: 10.4 + jitter / 10 }, now);
    recordMetrics(db, { station: '码垛-01', ts, picks: 29 + jitter, placements: 29 + jitter, placementInvalid: 0, cycleTimeS: 11.8 + jitter / 10 }, now);
    recordMetrics(db, { station: '码垛-02', ts, picks: 28 + jitter, placements: 28 + jitter, placementInvalid: slot === 4 ? 1 : 0, cycleTimeS: 12.1 + jitter / 10 }, now);
    recordMetrics(db, { station: '入库暂存区', ts, backlog: 8 + jitter }, now);
  }
}

export function logisticsSeedEvents(): EventInput[] {
  return [];
}
