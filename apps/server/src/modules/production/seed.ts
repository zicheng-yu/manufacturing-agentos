import type { SeedCtx } from '../../core/module.ts';
import { num, officialTable } from '../../seed/official.ts';

/** Equipment, sensors, repairs, work orders, changeovers, line capacity and OEE from the official pack. */
export function seedProduction({ db, dataset }: SeedCtx): void {
  // The fictional fixtures have no factory floor; production only exists in the official dataset.
  if (dataset !== 'official') return;

  const equipment = db.prepare(
    `INSERT INTO production_equipment (id, name, line, commissioned, takt_seconds, maintenance_cycle_days, key_parts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('01_设备主数据')) {
    equipment.run(r['设备编号'], r['设备名称'], r['所属产线'], r['投产日期'], num(r['设计节拍(秒)']) ?? 0, num(r['维保周期(天)']) ?? 0, r['关键部件']);
  }

  const sensor = db.prepare(
    `INSERT INTO production_sensors (equipment_id, ts, vibration, temperature, current, rpm, load, humidity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('02_设备传感器时序')) {
    sensor.run(
      r['设备编号'],
      r['时间戳'],
      num(r['主轴振动RMS(mm/s)']),
      num(r['主轴温度(℃)']),
      num(r['主轴电流(A)']),
      num(r['转速(rpm)']),
      num(r['负载率(%)']),
      num(r['环境湿度(%RH)']),
    );
  }

  const repair = db.prepare(
    `INSERT INTO production_repairs (id, equipment_id, occurred_at, symptom, cause, downtime_min, cost, lost_output, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('03_设备故障维修记录')) {
    repair.run(r['工单号'], r['设备编号'], r['故障发生时间'], r['故障现象'], r['故障原因'], num(r['停机时长(分钟)']) ?? 0, num(r['维修费用(元)']) ?? 0, num(r['损失产量(件)']) ?? 0, r['处理方式']);
  }

  const order = db.prepare(
    `INSERT INTO production_orders (id, product, qty, tier, due, unit_seconds, lines, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('05_生产工单')) {
    order.run(r['工单号'], r['产品型号'], num(r['订单量(件)']) ?? 0, r['客户等级'], r['交期'], num(r['单件工时(秒)']) ?? 0, r['可产线'], num(r['优先级得分']) ?? 0);
  }

  const changeover = db.prepare(`INSERT INTO production_changeover (from_product, to_product, minutes) VALUES (?, ?, ?)`);
  for (const r of officialTable('06_换型时间矩阵分钟')) {
    const from = r['从\\到'];
    for (const [to, minutes] of Object.entries(r)) if (to !== '从\\到') changeover.run(from, to, num(minutes) ?? 0);
  }

  const line = db.prepare(`INSERT INTO production_lines (id, hours, staff, bottleneck, yield_baseline, max_daily) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const r of officialTable('07_产线产能')) {
    line.run(r['产线'], num(r['日可用工时(小时)']) ?? 0, num(r['标配人数']) ?? 0, r['瓶颈工序'], num(r['良率基线(%)']) ?? 0, num(r['最大日产能(件)']) ?? 0);
  }

  const oee = db.prepare(
    `INSERT INTO production_oee (date, line, planned_min, downtime_min, availability, performance, quality, oee, top_loss) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('15_OEE日统计')) {
    const value = num(r['OEE(%)']);
    if (value === null) continue;
    oee.run(r['日期'], r['产线'], num(r['计划运行时间(min)']) ?? 0, num(r['停机时间(min)']) ?? 0, num(r['时间开动率(%)']) ?? 0, num(r['性能开动率(%)']) ?? 0, num(r['合格品率(%)']) ?? 0, value, r['主要停机原因']);
  }
}
