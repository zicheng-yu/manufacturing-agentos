import type { EventInput } from '../../core/events.ts';
import type { ModuleCtx } from '../../core/module.ts';
import { addDays, isoDate } from '../../core/util.ts';

// Demo data: a vehicle display module line (L1 中控屏, L2 仪表屏). Supplier names are fictional.
const SUPPLIERS = [
  ['SUP-JL', '昆山精联电子', 'FPC 柔性电路板', '华东', 'B', 7, 0.86, '现供 FPC-1203'],
  ['SUP-XC', '无锡信创柔电', 'FPC 柔性电路板', '华东', 'A', 10, 0.95, '备选，MOQ 较高'],
  ['SUP-DY', '东莞德源电路', 'FPC 柔性电路板', '华南', 'B+', 4, 0.92, '备选，交期短'],
  ['SUP-HG', '合肥恒光显示', 'TFT 玻璃基板', '华东', 'A', 6, 0.97, ''],
  ['SUP-BL', '常州明背光科技', '背光模组', '华东', 'A-', 5, 0.93, ''],
  ['SUP-XP', '上海芯平半导体', '显示驱动 IC', '华东', 'A', 14, 0.88, '晶圆产能紧张'],
  ['SUP-GM', '宁波光膜材料', '偏光片 / 光学胶', '华东', 'B+', 7, 0.94, ''],
  ['SUP-JM', '昆山精铝结构件', '铝合金背框', '华东', 'B', 5, 0.9, ''],
  ['SUP-ZX', '苏州周转箱业', 'KLT 周转料箱', '华东', 'A', 3, 0.98, ''],
] as const;

const MATERIALS = [
  ['FPC-1203', 'FPC 柔性电路板（12.3 英寸中控屏）', '柔性板 柔性电路 软板 排线', 'FPC', '片', 'L1 中控屏线', 1530, 900, 3, 'SUP-JL', 18.6],
  ['GLS-1230', 'TFT 玻璃基板（12.3 英寸）', '玻璃 基板', '玻璃基板', '片', 'L1 中控屏线', 5200, 850, 5, 'SUP-HG', 96.0],
  ['BLU-1230', '背光模组（12.3 英寸）', '背光 灯板', '背光', '套', 'L1 中控屏线', 3200, 880, 4, 'SUP-BL', 42.5],
  ['FRM-1230', '铝合金背框（12.3 英寸）', '背框 铝框 结构件', '结构件', '件', 'L1 中控屏线', 3100, 900, 3, 'SUP-JM', 23.8],
  ['DIC-0870', '显示驱动 IC', '驱动芯片 驱动IC 芯片', '芯片', '颗', 'L1/L2 共用', 5200, 1500, 5, 'SUP-XP', 11.2],
  ['FPC-1025', 'FPC 柔性电路板（10.25 英寸仪表屏）', '仪表', 'FPC', '片', 'L2 仪表屏线', 2400, 650, 3, 'SUP-JL', 15.4],
  ['POL-1025', '偏光片（10.25 英寸）', '偏光', '偏光片', '片', 'L2 仪表屏线', 4100, 700, 4, 'SUP-GM', 8.9],
  ['OCA-0300', '光学胶 OCA 0.3mm', '光学胶', '辅料', '片', 'L1/L2 共用', 9000, 1200, 5, 'SUP-GM', 3.2],
  ['KLT-4314', 'KLT 周转料箱 4314', '料箱 周转箱', '物流器具', '个', '厂内物流', 320, 20, 10, 'SUP-ZX', 46.0],
] as const;

export function seedSupply({ db, now }: ModuleCtx): void {
  const supplier = db.prepare(
    'INSERT INTO supply_suppliers (id, name, category, region, rating, lead_time_days, on_time_rate, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const s of SUPPLIERS) supplier.run(...s);

  const material = db.prepare(
    `INSERT INTO supply_materials (code, name, aliases, category, unit, line, on_hand, daily_usage, safety_days, supplier_id, unit_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of MATERIALS) material.run(...m);

  const order = db.prepare(
    'INSERT INTO supply_orders (id, material_code, supplier_id, qty, eta, delay_days, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const day = (n: number) => isoDate(addDays(now, n));
  order.run('PO-2611', 'FPC-1203', 'SUP-JL', 3000, day(1), 0, '在途');
  order.run('PO-2608', 'GLS-1230', 'SUP-HG', 4000, day(4), 0, '在途');
  order.run('PO-2609', 'BLU-1230', 'SUP-BL', 3000, day(3), 0, '在途');
  order.run('PO-2603', 'DIC-0870', 'SUP-XP', 6000, day(1), 0, '在途');
  order.run('PO-2612', 'FRM-1230', 'SUP-JM', 2000, day(5), 0, '在途');
  order.run('PO-2614', 'POL-1025', 'SUP-GM', 3000, day(6), 0, '在途');

  const quote = db.prepare(
    `INSERT INTO supply_quotes (id, material_code, supplier_id, unit_price, tax_included, moq, lead_time_days, payment_terms, quoted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const quoted = day(-5);
  quote.run('Q-101', 'FPC-1203', 'SUP-JL', 18.6, 1, 2000, 7, '月结 60 天', quoted);
  quote.run('Q-102', 'FPC-1203', 'SUP-XC', 16.9, 0, 5000, 10, '月结 30 天', quoted);
  quote.run('Q-103', 'FPC-1203', 'SUP-DY', 18.2, 1, 3000, 4, '预付 30%，余款月结 30 天', quoted);
  quote.run('Q-104', 'DIC-0870', 'SUP-XP', 11.2, 1, 5000, 14, '月结 60 天', quoted);
  quote.run('Q-105', 'DIC-0870', 'SUP-DY', 10.5, 0, 10000, 21, '月结 30 天', quoted);
  quote.run('Q-106', 'POL-1025', 'SUP-GM', 8.9, 1, 2000, 7, '月结 60 天', quoted);
}

export function supplySeedEvents(now: Date): EventInput[] {
  return [
    {
      domain: 'supply',
      type: 'inbound_delay',
      title: 'PO-2603 显示驱动 IC 到货延迟 2 天',
      summary: '上海芯平半导体反馈晶圆产能紧张，PO-2603 顺延 2 天',
      payload: { orderId: 'PO-2603', materialCode: 'DIC-0870', supplierId: 'SUP-XP', delayDays: 2 },
      source: { channel: 'seed', actor: '供应链经理' },
      at: addDays(now, -3),
    },
    {
      domain: 'supply',
      type: 'price_increase',
      title: '偏光片 POL-1025 报价上涨 6%',
      summary: '宁波光膜材料通知下月起偏光片单价由 8.40 元调整为 8.90 元',
      payload: { materialCode: 'POL-1025', supplierId: 'SUP-GM', changePct: 6 },
      source: { channel: 'seed', actor: '供应链经理' },
      at: addDays(now, -2),
    },
  ];
}
