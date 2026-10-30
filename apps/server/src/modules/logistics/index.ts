import type { Level } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireBridgeToken } from '../../core/bridge.ts';
import type { DomainModule } from '../../core/module.ts';
import { percent, round } from '../../core/util.ts';
import { siteAgent } from './agents.ts';
import { listStations, recordMetrics, stationStats, totals, worstStation } from './data.ts';
import { logisticsSeedEvents, seedLogistics } from './seed.ts';

const count = z.number().int().min(0).optional();
const MetricsBody = z.object({
  station: z.string().min(1),
  ts: z.string().datetime().optional(),
  recognitions: count,
  recognitionFailures: count,
  picks: count,
  pickFailures: count,
  placements: count,
  placementInvalid: count,
  cycleTimeS: z.number().min(0).nullable().optional(),
  backlog: count,
});

const stationGroup = (e: { source: { station?: string } }) => e.source.station ?? null;

export const logisticsModule: DomainModule = {
  id: 'logistics',
  name: '智能物流',
  description: '混合料箱识别、抓取、码垛现场看板与异常处理',
  schema: `
    CREATE TABLE IF NOT EXISTS logistics_stations (id TEXT PRIMARY KEY, zone TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logistics_bin_types (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, size TEXT NOT NULL, max_stack INTEGER NOT NULL, target_zone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logistics_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, station_id TEXT NOT NULL, ts TEXT NOT NULL,
      recognitions INTEGER NOT NULL DEFAULT 0, recognition_failures INTEGER NOT NULL DEFAULT 0,
      picks INTEGER NOT NULL DEFAULT 0, pick_failures INTEGER NOT NULL DEFAULT 0,
      placements INTEGER NOT NULL DEFAULT 0, placement_invalid INTEGER NOT NULL DEFAULT 0,
      cycle_time_s REAL, backlog INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS logistics_metrics_ts ON logistics_metrics(station_id, ts);`,
  seed: seedLogistics,
  seedEvents: logisticsSeedEvents,
  agents: [siteAgent],

  eventTypes: [
    { type: 'recognition_failed', label: '料箱识别失败', severity: 'warn' },
    { type: 'grasp_failed', label: '抓取失败', severity: 'warn' },
    { type: 'placement_invalid', label: '放置不合规', severity: 'warn' },
    { type: 'backlog_high', label: '入库积压', severity: 'warn', kind: 'state' },
    { type: 'station_down', label: '工位停机', severity: 'critical', kind: 'state' },
  ],

  signalRules: [
    {
      id: 'logistics-grasp',
      types: ['grasp_failed'],
      windowMinutes: 60,
      threshold: 3,
      severity: 'critical',
      groupBy: stationGroup,
      describe: (events, station) => ({
        title: `${station} 抓取连续失败`,
        summary: `60 分钟内抓取失败 ${events.reduce((s, e) => s + e.count, 0)} 次；${events.at(-1)!.summary}`,
      }),
      playbook: {
        decision: '批准故障码垛工位转人工辅助，并安排设备与视觉复检',
        impact: '码垛停滞造成入库积压，进而影响产线供料',
        owner: '物流主管',
        dueHours: 4,
        weight: 1,
      },
    },
    {
      id: 'logistics-recognition',
      types: ['recognition_failed'],
      windowMinutes: 60,
      threshold: 3,
      severity: 'warn',
      groupBy: stationGroup,
      describe: (events, station) => ({
        title: `${station} 料箱识别异常`,
        summary: `60 分钟内识别失败 ${events.reduce((s, e) => s + e.count, 0)} 次`,
      }),
      playbook: { decision: '安排视觉系统复检与补光调整', impact: '识别失败的料箱需人工复核，拉长节拍', owner: '物流主管', dueHours: 8, weight: 1 },
    },
    {
      id: 'logistics-placement',
      types: ['placement_invalid'],
      windowMinutes: 60,
      threshold: 2,
      severity: 'warn',
      groupBy: stationGroup,
      describe: (events, station) => ({
        title: `${station} 放置不合规`,
        summary: `60 分钟内放置检查不通过 ${events.reduce((s, e) => s + e.count, 0)} 次`,
      }),
      playbook: { decision: '核对码垛规则并复检已码放料箱', impact: '码放不合规有倒垛与物料损伤风险', owner: '物流主管', dueHours: 8, weight: 1 },
    },
    {
      id: 'logistics-backlog',
      types: ['backlog_high'],
      windowMinutes: 120,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({ title: '入库暂存区积压', summary: events.at(-1)!.summary }),
      playbook: { decision: '批准入库改道与临时人工搬运', impact: '积压物料无法及时上线，产线可能缺料', owner: '物流主管与供应链经理', dueHours: 4, weight: 2 },
    },
    {
      id: 'logistics-down',
      types: ['station_down'],
      windowMinutes: 120,
      threshold: 1,
      severity: 'critical',
      groupBy: stationGroup,
      describe: (events, station) => ({ title: `${station} 停机`, summary: events.at(-1)!.summary }),
      playbook: { decision: '确认停机工位的抢修时限与任务改派', impact: '工位停机直接降低厂内物流产能', owner: '物流主管', dueHours: 2, weight: 2 },
    },
  ],

  situation({ db, signals }) {
    // Latest report per station: the card shows what is happening now, not an hour's average.
    const latest = stationStats(db, 1);
    const t = totals(latest);
    const worst = worstStation(latest);
    const worstRate = worst ? (worst.picks - worst.pickFailures) / worst.picks : 1;
    const level: Level = signals.some((s) => s.severity === 'critical') ? 'alert' : signals.length ? 'watch' : 'normal';
    const top = signals.find((s) => s.severity === 'critical') ?? signals[0];
    return {
      title: '厂内物流产能',
      level,
      headline: top ? top.title : '识别、抓取、码垛运行正常',
      metrics: [
        worst && worstRate < 0.97
          ? { label: `${worst.station} 抓取`, value: percent(worst.picks - worst.pickFailures, worst.picks), tone: 'bad' }
          : { label: '实时抓取成功率', value: percent(t.picks - t.pickFailures, t.picks), tone: 'good' },
        { label: '码垛合规率', value: percent(t.placements - t.placementInvalid, t.placements), tone: 'neutral' },
        { label: '入库积压', value: t.backlog, unit: '箱', tone: t.backlog > 30 ? 'bad' : 'good' },
      ],
    };
  },

  overview({ db }) {
    const stats = stationStats(db);
    const t = totals(stats);
    const stations = listStations(db);
    const bins = db.prepare('SELECT * FROM logistics_bin_types ORDER BY code').all() as Record<string, unknown>[];
    return {
      metrics: [
        { label: '近期识别', value: t.recognitions, unit: '箱' },
        { label: '抓取成功率', value: percent(t.picks - t.pickFailures, t.picks) },
        { label: '码垛合规率', value: percent(t.placements - t.placementInvalid, t.placements) },
        { label: '平均节拍', value: t.avgCycleTime === null ? '—' : round(t.avgCycleTime, 1), unit: '秒' },
      ],
      tables: [
        {
          kind: 'table',
          title: '工位（各工位最近 6 次上报）',
          columns: ['工位', '区域', '类型', '状态', '识别', '识别失败', '抓取', '抓取失败', '码放', '不合规', '平均节拍(秒)', '积压'],
          rows: stats.map((s) => {
            const station = stations.find((x) => x.id === s.station)!;
            return [
              s.station,
              station.zone,
              station.kind,
              station.status,
              s.recognitions,
              s.recognitionFailures,
              s.picks,
              s.pickFailures,
              s.placements,
              s.placementInvalid,
              s.avgCycleTime === null ? '—' : round(s.avgCycleTime, 1),
              s.backlog,
            ];
          }),
        },
        {
          kind: 'table',
          title: '料箱规格与码垛规则',
          columns: ['规格', '名称', '尺寸(mm)', '最大堆叠层数', '目标区域'],
          rows: bins.map((b) => [String(b.code), String(b.name), String(b.size), Number(b.max_stack), String(b.target_zone)]),
        },
      ],
    };
  },

  onEvent({ db }, event) {
    if (event.type === 'station_down' && event.source.station) {
      db.prepare(`UPDATE logistics_stations SET status = '停机' WHERE id = ?`).run(event.source.station);
    }
  },

  routes(app, deps) {
    // Simulation bridge: periodic per-station counters. See docs/event-bridge.md.
    app.post('/metrics', async (c) => {
      requireBridgeToken(c, deps);
      const body = await c.req.json().catch(() => null);
      const items = z.array(MetricsBody).min(1).max(500).safeParse(Array.isArray(body) ? body : [body]);
      if (!items.success) throw new HTTPException(400, { message: `指标格式错误：${items.error.issues[0]?.message}` });
      const known = new Set(listStations(deps.db).map((s) => s.id));
      const unknown = items.data.find((m) => !known.has(m.station));
      if (unknown) throw new HTTPException(400, { message: `未知工位：${unknown.station}` });
      const now = deps.clock();
      for (const item of items.data) recordMetrics(deps.db, item, now);
      return c.json({ accepted: items.data.length });
    });
  },
};
