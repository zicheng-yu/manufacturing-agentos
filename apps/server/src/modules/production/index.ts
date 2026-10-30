import type { Level } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireBridgeToken } from '../../core/bridge.ts';
import { evaluateDomain } from '../../core/signals.ts';
import type { DomainModule } from '../../core/module.ts';
import { syncStateAlerts } from '../../core/state-alerts.ts';
import { addMinutes, chinaStamp, round } from '../../core/util.ts';
import { equipmentAgent, oeeAgent, scheduleAgent } from './agents.ts';
import { equipmentHealth, lineOee, listEquipment, listRepairs, OEE_TARGET, plantLosses, schedule, VIBRATION_ALARM } from './data.ts';
import { seedProduction } from './seed.ts';

const Reading = z.object({
  equipmentId: z.string().min(1),
  ts: z.string().datetime().optional(),
  vibration: z.number().min(0).nullable().optional(),
  temperature: z.number().nullable().optional(),
  current: z.number().nullable().optional(),
  rpm: z.number().nullable().optional(),
  load: z.number().nullable().optional(),
});

const plantOee = (lines: ReturnType<typeof lineOee>) => round(lines.reduce((s, l) => s + l.oee, 0) / (lines.length || 1), 1);

export const productionModule: DomainModule = {
  id: 'production',
  name: '生产设备',
  description: '设备健康、OEE 与排产：让设备少停机、工单按期交',
  schema: `
    CREATE TABLE IF NOT EXISTS production_equipment (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, line TEXT NOT NULL, commissioned TEXT NOT NULL,
      takt_seconds REAL NOT NULL, maintenance_cycle_days INTEGER NOT NULL, key_parts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS production_sensors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, equipment_id TEXT NOT NULL, ts TEXT NOT NULL,
      vibration REAL, temperature REAL, current REAL, rpm REAL, load REAL, humidity REAL
    );
    CREATE INDEX IF NOT EXISTS production_sensors_eq ON production_sensors(equipment_id, ts);
    CREATE TABLE IF NOT EXISTS production_repairs (
      id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL, occurred_at TEXT NOT NULL, symptom TEXT NOT NULL, cause TEXT NOT NULL,
      downtime_min REAL NOT NULL, cost REAL NOT NULL, lost_output REAL NOT NULL, action TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS production_orders (
      id TEXT PRIMARY KEY, product TEXT NOT NULL, qty INTEGER NOT NULL, tier TEXT NOT NULL, due TEXT NOT NULL,
      unit_seconds REAL NOT NULL, lines TEXT NOT NULL, priority REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS production_changeover (from_product TEXT NOT NULL, to_product TEXT NOT NULL, minutes REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS production_lines (
      id TEXT PRIMARY KEY, hours REAL NOT NULL, staff INTEGER NOT NULL, bottleneck TEXT NOT NULL,
      yield_baseline REAL NOT NULL, max_daily REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS production_oee (
      date TEXT NOT NULL, line TEXT NOT NULL, planned_min REAL NOT NULL, downtime_min REAL NOT NULL, availability REAL NOT NULL,
      performance REAL NOT NULL, quality REAL NOT NULL, oee REAL NOT NULL, top_loss TEXT NOT NULL
    );`,
  seed: seedProduction,
  agents: [equipmentAgent, oeeAgent, scheduleAgent],

  eventTypes: [
    { type: 'vibration_alarm', label: '振动超限', severity: 'critical', kind: 'state' },
    { type: 'oee_low', label: 'OEE 低于目标', severity: 'warn', kind: 'state' },
    { type: 'order_due_risk', label: '工单交期风险', severity: 'critical', kind: 'state' },
  ],

  signalRules: [
    {
      id: 'production-vibration',
      types: ['vibration_alarm'],
      windowMinutes: 24 * 60,
      threshold: 1,
      severity: 'critical',
      groupBy: (e) => e.source.station ?? null,
      describe: (events, equipment) => ({ title: `${equipment} 振动超限`, summary: events.at(-1)!.summary }),
      playbook: {
        decision: '安排振动超限设备停机点检，评估是否提前保养',
        impact: '历史数据中振动超限后数天内发生了故障停机',
        owner: '设备主管',
        dueHours: 8,
        weight: 2,
      },
    },
    {
      id: 'production-oee',
      types: ['oee_low'],
      windowMinutes: 7 * 24 * 60,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: { decision: '组织 OEE 损失专项，先攻最大损失项', impact: 'OEE 偏低直接压缩有效产能，拖累交期', owner: '生产经理', dueHours: 72, weight: 2 },
    },
    {
      id: 'production-due',
      types: ['order_due_risk'],
      windowMinutes: 7 * 24 * 60,
      threshold: 1,
      severity: 'critical',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: {
        decision: '确认延期工单的加班、调线或外协方案，并与客户沟通交期',
        impact: '按当前产能部分客户订单会延期交付',
        owner: '生产经理与销售',
        dueHours: 24,
        weight: 3,
      },
    },
  ],

  /** OEE and due-date risk follow the data; vibration alarms come from readings in the last 24 hours. */
  beforeEvaluate(deps) {
    const { db } = deps;
    if (listEquipment(db).length === 0) return;
    const now = deps.clock();
    const lines = lineOee(db);
    const plant = plantOee(lines);
    const losses = plantLosses(db);
    syncStateAlerts(
      deps,
      'production',
      'oee_low',
      plant < OEE_TARGET
        ? [
            {
              key: 'plant',
              title: `全厂 OEE ${plant}%，低于目标 ${OEE_TARGET}%`,
              summary: `近 7 日全厂 OEE ${plant}%；最低 ${[...lines].sort((a, b) => a.oee - b.oee)[0]?.line}；最大损失「${losses[0]?.reason}」${Math.round(losses[0]?.downtimeMin ?? 0)} 分钟`,
              payload: { oee: plant, target: OEE_TARGET, topLoss: losses[0]?.reason },
            },
          ]
        : [],
      'OEE 规则',
    );
    const late = schedule(db, now).rows.filter((r) => r.late);
    syncStateAlerts(
      deps,
      'production',
      'order_due_risk',
      late.length
        ? [
            {
              key: 'plant',
              title: `${late.length} 张工单预计延期`,
              summary: late.map((r) => `${r.order.id}（${r.order.tier}）延期 ${-r.slackDays} 天`).join('；'),
              payload: { orders: late.map((r) => r.order.id), strategic: late.filter((r) => r.order.tier === '战略客户').length },
            },
          ]
        : [],
      '排产规则',
    );
    const since = chinaStamp(addMinutes(now, -24 * 60));
    const live = equipmentHealth(db).filter((h) => h.alarms.some((a) => a.ts >= since));
    syncStateAlerts(
      deps,
      'production',
      'vibration_alarm',
      live.map((h) => {
        const last = h.alarms.at(-1)!;
        const lead = h.leadDays.length ? `；历史上该设备超限后 ${h.leadDays[0].days} 天发生过「${h.leadDays[0].repair.symptom}」` : '';
        return {
          key: h.equipment.id,
          station: h.equipment.id,
          title: `${h.equipment.id} 振动 ${last.vibration} mm/s`,
          summary: `${h.equipment.name}（${h.equipment.line}）${last.ts} 振动 ${last.vibration} mm/s，超过 ISO 告警线 ${VIBRATION_ALARM}；基线 ${h.baseline}${lead}`,
          payload: { equipmentId: h.equipment.id, line: h.equipment.line, vibration: last.vibration, baseline: h.baseline },
        };
      }),
      '设备健康规则',
    );
  },

  situation({ db, now, signals }) {
    const lines = lineOee(db);
    const late = listEquipment(db).length ? schedule(db, now).rows.filter((r) => r.late).length : 0;
    const alarms = signals.filter((s) => s.ruleId === 'production-vibration').length;
    const level: Level = signals.some((s) => s.severity === 'critical') ? 'alert' : signals.length ? 'watch' : 'normal';
    const top = signals.find((s) => s.severity === 'critical') ?? signals[0];
    const plant = plantOee(lines);
    return {
      title: '生产与设备',
      level,
      headline: top ? top.title : lines.length ? '设备与产线运行平稳' : '暂无生产数据',
      metrics: [
        { label: '近 7 日 OEE', value: lines.length ? plant : '—', unit: lines.length ? '%' : undefined, tone: plant < OEE_TARGET ? 'bad' : 'good' },
        { label: '设备告警', value: alarms, unit: '台', tone: alarms ? 'bad' : 'good' },
        { label: '延期工单', value: late, unit: '张', tone: late ? 'bad' : 'good' },
      ],
    };
  },

  overview({ db, now }) {
    const health = equipmentHealth(db);
    const lines = lineOee(db);
    const plan = listEquipment(db).length ? schedule(db, now).rows : [];
    return {
      metrics: [
        { label: '设备', value: health.length, unit: '台' },
        { label: '近 7 日 OEE', value: lines.length ? plantOee(lines) : '—', unit: lines.length ? '%' : undefined },
        { label: '在排工单', value: plan.length, unit: '张' },
        { label: '预计延期', value: plan.filter((r) => r.late).length, unit: '张' },
      ],
      tables: [
        {
          kind: 'table',
          title: '设备健康',
          columns: ['设备', '名称', '产线', '基线振动', '最新读数', '累计超限', '缺失读数', '状态'],
          rows: health.map((h) => [h.equipment.id, h.equipment.name, h.equipment.line, h.baseline, h.latest?.vibration ?? '—', h.alarms.length, h.missing, h.status]),
          note: `振动 mm/s；≥${VIBRATION_ALARM} 为 ISO 10816 告警区`,
        },
        {
          kind: 'table',
          title: '产线 OEE（近 7 日）',
          columns: ['产线', 'OEE', '时间开动率', '性能开动率', '合格品率', '主要损失'],
          rows: lines.map((l) => [l.line, `${l.oee}%`, `${l.availability}%`, `${l.performance}%`, `${l.quality}%`, l.losses[0]?.reason ?? '—']),
        },
        {
          kind: 'table',
          title: '排产计划',
          columns: ['工单', '产品', '数量', '客户等级', '产线', '完工', '交期', '余量(天)'],
          rows: plan.map((r) => [r.order.id, r.order.product, r.order.qty, r.order.tier, r.line, r.finish, r.order.due, r.slackDays]),
        },
        {
          kind: 'table',
          title: '故障维修记录',
          columns: ['工单', '设备', '时间', '现象', '原因', '停机(分钟)', '费用(元)', '处理'],
          rows: listRepairs(db).map((r) => [r.id, r.equipmentId, r.occurredAt, r.symptom, r.cause, r.downtimeMin, r.cost, r.action]),
        },
      ],
    };
  },

  routes(app, deps) {
    // Live sensor readings from the shop floor or the simulation; a reading past the alarm line raises an event at once.
    app.post('/readings', async (c) => {
      requireBridgeToken(c, deps);
      const body = await c.req.json().catch(() => null);
      const items = z.array(Reading).min(1).max(500).safeParse(Array.isArray(body) ? body : [body]);
      if (!items.success) throw new HTTPException(400, { message: `读数格式错误：${items.error.issues[0]?.message}` });
      const known = new Set(listEquipment(deps.db).map((e) => e.id));
      const unknown = items.data.find((r) => !known.has(r.equipmentId));
      if (unknown) throw new HTTPException(400, { message: `未知设备：${unknown.equipmentId}` });
      const now = deps.clock();
      const insert = deps.db.prepare(
        `INSERT INTO production_sensors (equipment_id, ts, vibration, temperature, current, rpm, load) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of items.data) {
        const ts = chinaStamp(r.ts ? new Date(r.ts) : now);
        insert.run(r.equipmentId, ts, r.vibration ?? null, r.temperature ?? null, r.current ?? null, r.rpm ?? null, r.load ?? null);
      }
      evaluateDomain(deps, 'production');
      return c.json({ accepted: items.data.length });
    });
  },
};

