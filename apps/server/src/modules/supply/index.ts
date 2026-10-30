import type { Level } from '@agentos/shared';
import type { DomainModule } from '../../core/module.ts';
import { addDays, isoDate, round } from '../../core/util.ts';
import { inventoryAgent, sourcingAgent } from './agents.ts';
import { coverDays, listMaterials, listOrders, materialStatus, supplierName } from './data.ts';
import { seedSupply, supplySeedEvents } from './seed.ts';

export const supplyModule: DomainModule = {
  id: 'supply',
  name: '供应链',
  description: '寻源、比价、库存与在途：让采购与库存更简单',
  schema: `
    CREATE TABLE IF NOT EXISTS supply_suppliers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, region TEXT NOT NULL,
      rating TEXT NOT NULL, lead_time_days INTEGER NOT NULL, on_time_rate REAL NOT NULL, note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS supply_materials (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL, line TEXT NOT NULL,
      on_hand INTEGER NOT NULL, daily_usage INTEGER NOT NULL, safety_days INTEGER NOT NULL,
      supplier_id TEXT NOT NULL, unit_price REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supply_orders (
      id TEXT PRIMARY KEY, material_code TEXT NOT NULL, supplier_id TEXT NOT NULL, qty INTEGER NOT NULL,
      eta TEXT NOT NULL, delay_days INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supply_quotes (
      id TEXT PRIMARY KEY, material_code TEXT NOT NULL, supplier_id TEXT NOT NULL, unit_price REAL NOT NULL,
      tax_included INTEGER NOT NULL, moq INTEGER NOT NULL, lead_time_days INTEGER NOT NULL,
      payment_terms TEXT NOT NULL, quoted_at TEXT NOT NULL
    );`,
  seed: seedSupply,
  seedEvents: supplySeedEvents,
  agents: [sourcingAgent, inventoryAgent],

  eventTypes: [
    { type: 'inbound_delay', label: '到货延迟', severity: 'warn', dedupeFields: ['orderId'] },
    { type: 'stockout_risk', label: '缺料风险', severity: 'critical', dedupeFields: ['materialCode'] },
    { type: 'price_increase', label: '价格上涨', severity: 'info', dedupeFields: ['materialCode'] },
    { type: 'supplier_risk', label: '供应商风险', severity: 'warn', dedupeFields: ['supplierId'] },
  ],

  signalRules: [
    {
      id: 'supply-inbound-delays',
      types: ['inbound_delay'],
      windowMinutes: 7 * 24 * 60,
      threshold: 2,
      severity: 'warn',
      describe: (events) => ({
        title: `近 7 天 ${events.length} 起到货延迟`,
        summary: events.map((e) => e.title).join('；'),
      }),
      playbook: {
        decision: '确认延迟物料的替代货源与产线排产调整',
        impact: '在途延迟叠加会压缩可用库存天数，可能影响本周交付',
        owner: '供应链经理牵头，生产、品质配合',
        dueHours: 24,
      },
    },
    {
      id: 'supply-stockout',
      types: ['stockout_risk'],
      windowMinutes: 3 * 24 * 60,
      threshold: 1,
      severity: 'critical',
      groupBy: (e) => String(e.payload.materialCode ?? '') || null,
      describe: (events, group) => ({
        title: `${String(events.at(-1)!.payload.materialName ?? group)} 缺料风险`,
        summary: events.at(-1)!.summary,
      }),
      playbook: {
        decision: '批准紧急补货或切换供应商，并确认受影响产线的排产',
        impact: '缺料将直接导致产线停线',
        owner: '供应链经理',
        dueHours: 8,
      },
    },
    {
      id: 'supply-price',
      types: ['price_increase'],
      windowMinutes: 14 * 24 * 60,
      threshold: 2,
      severity: 'info',
      describe: (events) => ({
        title: `近 14 天 ${events.length} 项物料涨价`,
        summary: events.map((e) => e.title).join('；'),
      }),
      playbook: {
        decision: '确认涨价物料的议价策略与成本影响口径',
        impact: '材料成本上升压缩项目毛利',
        owner: '供应链经理与财务',
        dueHours: 72,
      },
    },
  ],

  situation({ db, signals }) {
    const materials = listMaterials(db);
    const low = materials.filter((m) => materialStatus(m) !== '正常');
    const delayed = listOrders(db).filter((o) => o.delayDays > 0);
    const level: Level = signals.some((s) => s.severity === 'critical')
      ? 'alert'
      : signals.length > 0 || low.length > 0
        ? 'watch'
        : 'normal';
    const top = signals.find((s) => s.severity === 'critical') ?? signals[0];
    return {
      title: '供应链在途风险',
      level,
      headline: top ? top.title : low.length ? `${low.length} 项物料低于安全库存` : '库存与在途整体可控',
      metrics: [
        { label: '低于安全库存', value: low.length, unit: '项', tone: low.length ? 'bad' : 'good' },
        { label: '延迟在途单', value: delayed.length, unit: '单', tone: delayed.length ? 'bad' : 'good' },
        { label: '活跃信号', value: signals.length, unit: '条', tone: signals.length ? 'bad' : 'neutral' },
      ],
    };
  },

  overview({ db }) {
    const materials = listMaterials(db);
    const orders = listOrders(db);
    const suppliers = db.prepare('SELECT * FROM supply_suppliers ORDER BY category, name').all() as Record<string, unknown>[];
    return {
      metrics: [
        { label: '物料', value: materials.length, unit: '项' },
        { label: '在途订单', value: orders.filter((o) => o.status === '在途').length, unit: '单' },
        { label: '合格供应商', value: suppliers.length, unit: '家' },
        { label: '低于安全库存', value: materials.filter((m) => materialStatus(m) !== '正常').length, unit: '项' },
      ],
      tables: [
        {
          kind: 'table',
          title: '库存与可用天数',
          columns: ['料号', '物料', '产线', '库存', '在途', '日耗', '可用天数', '安全天数', '状态'],
          rows: materials.map((m) => [
            m.code,
            m.name,
            m.line,
            m.onHand,
            m.inTransit,
            m.dailyUsage,
            round(coverDays(m), 1),
            m.safetyDays,
            materialStatus(m),
          ]),
          note: '可用天数 = （库存 + 按期在途）÷ 日耗',
        },
        {
          kind: 'table',
          title: '在途订单',
          columns: ['订单', '料号', '供应商', '数量', '预计到货', '延迟天数', '状态'],
          rows: orders.map((o) => [o.id, o.materialCode, supplierName(db, o.supplierId), o.qty, o.eta, o.delayDays, o.status]),
        },
        {
          kind: 'table',
          title: '供应商',
          columns: ['编号', '名称', '品类', '区域', '评级', '标准交期(天)', '准交率'],
          rows: suppliers.map((s) => [
            String(s.id),
            String(s.name),
            String(s.category),
            String(s.region),
            String(s.rating),
            Number(s.lead_time_days),
            `${Math.round(Number(s.on_time_rate) * 100)}%`,
          ]),
        },
      ],
    };
  },

  onEvent({ db, now, emit }, event, { created }) {
    if (event.type !== 'inbound_delay' || !created) return;
    const orderId = String(event.payload.orderId ?? '');
    const delayDays = Number(event.payload.delayDays ?? 0);
    const order = listOrders(db).find((o) => o.id === orderId);
    if (!order || delayDays <= 0) return;
    const eta = isoDate(addDays(new Date(order.eta), delayDays));
    db.prepare(`UPDATE supply_orders SET delay_days = delay_days + ?, eta = ?, status = '延迟' WHERE id = ?`).run(
      delayDays,
      eta,
      orderId,
    );
    const material = listMaterials(db).find((m) => m.code === order.materialCode);
    if (material && materialStatus(material) === '缺料风险') {
      emit({
        domain: 'supply',
        type: 'stockout_risk',
        title: `${material.name} 缺料风险`,
        summary: `${orderId} 延迟 ${delayDays} 天后，${material.line} ${material.name} 可用 ${round(coverDays(material), 1)} 天，低于安全天数 ${material.safetyDays} 天`,
        payload: { materialCode: material.code, materialName: material.name, line: material.line, coverDays: round(coverDays(material), 1) },
        source: { channel: event.source.channel, actor: '库存规则' },
        at: now,
      });
    }
  },
};
