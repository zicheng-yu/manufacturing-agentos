// The official material pack mapped onto the supply tables, plus the rules from 《工厂供应链管理制度》 that the
// agents apply: the supplier scorecard (5.2/5.3), purchase approval thresholds (4.1) and safety stock basis (3.4).
import type { TableArtifact } from '@agentos/shared';
import type { Deps } from '../../core/deps.ts';
import type { AgentContext, AgentCtx } from '../../core/module.ts';
import { syncStateAlerts } from '../../core/state-alerts.ts';
import { addDays, isoDate, round } from '../../core/util.ts';
import type { DB, Row } from '../../db.ts';
import { cite, num, officialTable } from '../../seed/official.ts';
import { listMaterials, listQuotes, listSuppliers, materialStatus, type Material } from './data.ts';
import { resolveMaterial } from './lookup.ts';

const REGION: Record<string, string> = { 苏州: '华东', 无锡: '华东', 宁波: '华东', 常州: '华东', 东莞: '华南' };
const DAYS_PER_MONTH = 30.4;

export const DEMAND_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supply_demand (
    month TEXT NOT NULL, material_code TEXT NOT NULL, qty INTEGER NOT NULL, promo TEXT NOT NULL,
    price REAL, in_transit INTEGER, PRIMARY KEY (month, material_code)
  );`;

/** Columns the official pack carries beyond the original fixtures. */
export const OFFICIAL_COLUMNS = {
  supply_materials: {
    safety_stock: 'INTEGER NOT NULL DEFAULT 0',
    abc: "TEXT NOT NULL DEFAULT ''",
    stale_days: 'INTEGER NOT NULL DEFAULT 0',
    location: "TEXT NOT NULL DEFAULT ''",
    batch: "TEXT NOT NULL DEFAULT ''",
  },
  supply_suppliers: {
    ppm: 'REAL',
    capacity_wan: 'REAL',
    payment_days: 'INTEGER',
    strategic: 'INTEGER NOT NULL DEFAULT 0',
  },
  supply_quotes: { valid_until: "TEXT NOT NULL DEFAULT ''" },
} as const;

export function seedOfficialSupply(db: DB): void {
  const demand = officialTable('13_需求历史');
  const insertDemand = db.prepare('INSERT INTO supply_demand (month, material_code, qty, promo, price, in_transit) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of demand) insertDemand.run(r['月份'], r['物料编码'], num(r['实际销量(件)']) ?? 0, r['促销标识'], num(r['单价(元)']), num(r['在途量(件)']));

  const quotes = officialTable('14_供应商报价比价');
  const suppliers = new Map<string, string>();
  const insertSupplier = db.prepare(
    `INSERT INTO supply_suppliers (id, name, category, region, rating, lead_time_days, on_time_rate, note, ppm, capacity_wan, payment_days, strategic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertQuote = db.prepare(
    `INSERT INTO supply_quotes (id, material_code, supplier_id, unit_price, tax_included, moq, lead_time_days, payment_terms, quoted_at, valid_until)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, '', ?)`,
  );
  const names = new Map(officialTable('11_仓储库存').map((r) => [r['物料编码'], r['物料名称']]));
  quotes.forEach((r, i) => {
    const name = r['供应商'];
    const id = suppliers.get(name) ?? `SUP-${String(suppliers.size + 1).padStart(2, '0')}`;
    if (!suppliers.has(name)) {
      suppliers.set(name, id);
      const category = (names.get(r['物料编码']) ?? '').replace(/\d+$/, '') || '未分类';
      insertSupplier.run(
        id,
        name,
        category,
        REGION[name.slice(0, 2)] ?? '—',
        '—',
        num(r['交期(天)']) ?? 0,
        (num(r['准时交付率(%)']) ?? 0) / 100,
        `${r['是否战略合作'] === '是' ? '战略合作；' : ''}年产能 ${r['年产能(万件)']} 万件`,
        num(r['来料不良率(PPM)']),
        num(r['年产能(万件)']),
        num(r['账期(天)']),
        r['是否战略合作'] === '是' ? 1 : 0,
      );
    }
    insertQuote.run(`Q-${String(i + 1).padStart(3, '0')}`, r['物料编码'], id, num(r['含税单价(元)']) ?? 0, num(r['MOQ(件)']) ?? 0, num(r['交期(天)']) ?? 0, `账期 ${r['账期(天)']} 天`, r['报价有效期']);
  });

  // Daily usage only exists where there is demand history; elsewhere stock is judged against the safety quantity.
  const usage = new Map<string, number>();
  for (const code of new Set(demand.map((r) => r['物料编码']))) {
    const recent = demand.filter((r) => r['物料编码'] === code).slice(-6).map((r) => num(r['实际销量(件)']) ?? 0);
    usage.set(code, Math.round(recent.reduce((a, b) => a + b, 0) / recent.length / DAYS_PER_MONTH));
  }
  const insertMaterial = db.prepare(
    `INSERT INTO supply_materials (code, name, aliases, category, unit, line, on_hand, daily_usage, safety_days, supplier_id, unit_price,
       safety_stock, abc, stale_days, location, batch)
     VALUES (?, ?, ?, ?, '件', ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('11_仓储库存')) {
    const code = r['物料编码'];
    const category = r['物料名称'].replace(/\d+$/, '');
    const safety = num(r['安全库存']) ?? 0;
    const daily = usage.get(code) ?? 0;
    insertMaterial.run(
      code,
      r['物料名称'],
      category,
      category,
      `库位 ${r['库位']}`,
      num(r['库存数量']) ?? 0,
      daily,
      daily ? Math.round(safety / daily) : 0,
      num(r['单价(元)']) ?? 0,
      safety,
      r['ABC分类'],
      num(r['呆滞天数']) ?? 0,
      r['库位'],
      r['批次'],
    );
  }
}

export interface SupplierScore {
  supplierId: string;
  name: string;
  q: number;
  d: number;
  c: number;
  s: number;
  t: number;
  total: number;
  grade: string;
}

/** Grades from 5.3 by total score. */
function grade(total: number, strategic: boolean): string {
  if (total >= 90) return strategic ? '战略供应商' : '优选供应商';
  if (total >= 80) return '优选供应商';
  if (total >= 70) return '合格供应商';
  if (total >= 60) return '考察 / 限用';
  return '淘汰';
}

/**
 * Scorecard per 5.2 (Q 35%, D 30%, C 20%, S 10%, T 5%) from the quote sheet. The sheet has no service or
 * technology data, so S and T are held at 80 and marked for the requesting department to rate.
 */
export function supplierScores(db: DB, materialCode: string): SupplierScore[] {
  const rows = db
    .prepare(
      `SELECT q.unit_price, s.id, s.name, s.on_time_rate, s.ppm, s.payment_days, s.strategic FROM supply_quotes q
       JOIN supply_suppliers s ON s.id = q.supplier_id WHERE q.material_code = ? AND s.ppm IS NOT NULL`,
    )
    .all(materialCode) as Row[];
  if (rows.length === 0) return [];
  const minPrice = Math.min(...rows.map((r) => Number(r.unit_price)));
  return rows
    .map((r) => {
      const q = Math.max(0, 100 - Number(r.ppm) / 20);
      const d = Math.max(0, 100 - (100 - Number(r.on_time_rate) * 100) * 5);
      const c = 0.7 * ((minPrice / Number(r.unit_price)) * 100) + 0.3 * Math.min(100, (Number(r.payment_days ?? 0) / 90) * 100);
      const total = 0.35 * q + 0.3 * d + 0.2 * c + 0.1 * 80 + 0.05 * 80;
      return { supplierId: String(r.id), name: String(r.name), q: round(q, 1), d: round(d, 1), c: round(c, 1), s: 80, t: 80, total: round(total, 1), grade: grade(total, Number(r.strategic) === 1) };
    })
    .sort((a, b) => b.total - a.total);
}

export function scorecardTable(scores: SupplierScore[]): TableArtifact {
  return {
    kind: 'table',
    title: '供应商绩效评分卡',
    columns: ['供应商', '质量 Q(35%)', '交付 D(30%)', '成本 C(20%)', '服务 S(10%)', '技术 T(5%)', '综合', '分级'],
    rows: scores.map((s) => [s.name, s.q, s.d, s.c, `${s.s}*`, `${s.t}*`, s.total, s.grade]),
    note: `依据${cite('SCM-2025-001-5.2')}与 5.3。Q = 100 − PPM/20；D = 100 −（100 − 准交率%）× 5；C = 0.7 × 价格竞争力 + 0.3 × 账期支持（账期/90 天）；*S、T 素材无数据，暂按 80 计，待需求部门评价`,
  };
}

/** Approval route from 4.1 by order amount (yuan). */
export function approvalRoute(amount: number): string {
  if (amount < 50_000) return '合格供方名单内直接下单，采购主管批准';
  if (amount < 200_000) return '三方以上书面比价，供应链经理批准';
  if (amount < 1_000_000) return '招标或竞争性谈判，跨职能评标小组，分管副总批准';
  return '正式招标，供委会审定，总经理批准';
}

/** Safety stock basis from 3.4 by ABC class, in days of usage. */
const SAFETY_BASIS: Record<string, { min: number; label: string }> = {
  A: { min: 7, label: 'A 类：1–2 周用量' },
  B: { min: 7, label: 'B 类：交期 + 7 天用量' },
  C: { min: 30, label: 'C 类：1–2 个月用量' },
};

export function safetyCheck(m: Material & { abc?: string; safetyStock?: number }): string | null {
  if (!m.dailyUsage || !m.abc || !m.safetyStock) return null;
  const basis = SAFETY_BASIS[m.abc];
  if (!basis) return null;
  const days = round(m.safetyStock / m.dailyUsage, 1);
  // The policy's lower bound in units, so the answer can say how far the parameter is off.
  const target = Math.ceil((m.dailyUsage * basis.min) / 100) * 100;
  return days < basis.min
    ? `${m.code} 安全库存 ${m.safetyStock} 件只够 ${days} 天用量，低于${cite('SCM-2025-001-3.4')}的基准（${basis.label}）；按日耗 ${m.dailyUsage} 件，下限约 ${target} 件，参数需上调约 ${target - m.safetyStock} 件`
    : null;
}

export interface Forecast {
  months: { month: string; qty: number; promo: string; inTransit: number | null }[];
  baseline: number;
  promoUplift: number | null;
  nextMonth: number;
  inTransit: number | null;
}

/** Next month from the last six non-promotion months, with the observed promotion uplift shown separately. */
export function demandForecast(db: DB, code: string): Forecast | null {
  const rows = (db.prepare('SELECT * FROM supply_demand WHERE material_code = ? ORDER BY month').all(code) as Row[]).map((r) => ({
    month: String(r.month),
    qty: Number(r.qty),
    promo: String(r.promo),
    inTransit: r.in_transit === null ? null : Number(r.in_transit),
  }));
  if (rows.length === 0) return null;
  const plain = rows.filter((r) => r.promo === '无');
  const promo = rows.filter((r) => r.promo !== '无');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const baseline = Math.round(avg(plain.slice(-6).map((r) => r.qty)));
  const promoAvg = avg(promo.map((r) => r.qty));
  const plainAvg = avg(plain.map((r) => r.qty));
  return {
    months: rows,
    baseline,
    promoUplift: promo.length && plainAvg ? round(promoAvg / plainAvg - 1, 3) : null,
    nextMonth: baseline,
    inTransit: rows.at(-1)?.inTransit ?? null,
  };
}

function officialMaterial(db: DB, code: string) {
  return db.prepare('SELECT safety_stock, abc, stale_days FROM supply_materials WHERE code = ?').get(code) as Row | undefined;
}

/** Adds the scorecard, approval route and policy checks to a sourcing answer about a quoted material. */
export function enrichSourcing(ctx: AgentCtx, result: AgentContext): AgentContext {
  if (ctx.deps.config.dataset !== 'official') return result;
  const materials = listMaterials(ctx.db, ctx.now);
  const material = resolveMaterial(materials, listSuppliers(ctx.db), ctx.input, ctx.history, new Set());
  if (!material) return result;
  const scores = supplierScores(ctx.db, material.code);
  if (scores.length === 0) return result;
  const row = officialMaterial(ctx.db, material.code);
  const extra = { abc: String(row?.abc ?? ''), safetyStock: Number(row?.safety_stock ?? 0) };
  const best = scores[0];
  const quote = listQuotes(ctx.db, material.code).find((q) => q.supplierId === best.supplierId);
  const qty = Math.max(quote?.moq ?? 0, Math.round(material.dailyUsage * DAYS_PER_MONTH));
  const amount = (quote?.unitPrice ?? 0) * qty;
  const check = safetyCheck({ ...material, ...extra });
  const forecast = demandForecast(ctx.db, material.code);
  // A stockout within days cannot wait for a tender: the policy's emergency route applies.
  const urgent = material.dailyUsage > 0 && material.cover < (quote?.leadTimeDays ?? 7) + 7;
  const emergency = urgent
    ? [
        `距预计断料（${material.stockoutDate ?? '—'}）约 ${round(material.cover, 1)} 天，常规招标 / 竞争性谈判来不及`,
        `${cite('SCM-2025-001-4.2')}：紧急采购由供应链经理先批后补，24 小时内补齐书面审批`,
        `${cite('SCM-2025-001-10.3')}：可能导致停线 2 小时以上属一级风险，由供委会牵头应急小组（催交、空运、替代认证特批、客户交期协调）；将在 24 小时内导致停线的须 1 小时内上报分管副总与供委会`,
      ]
    : [];
  return {
    ...result,
    blocks: [
      ...result.blocks,
      { title: '供应商绩效评分卡（制度 5.2）', lines: scores.map((s) => `${s.name}：综合 ${s.total}（Q ${s.q} / D ${s.d} / C ${s.c}），${s.grade}`) },
      {
        title: '采购审批路径（制度 4.1）',
        lines: [`按一个月用量 ${qty} 件 × ${quote?.unitPrice ?? '—'} 元 ≈ ${round(amount / 10000, 1)} 万元：${approvalRoute(amount)}`, ...emergency],
      },
      ...(forecast ? [{ title: '需求预测', lines: [`近 6 个非促销月平均 ${forecast.baseline} 件/月${forecast.promoUplift !== null ? `，促销月平均高 ${round(forecast.promoUplift * 100, 1)}%` : ''}；最新在途 ${forecast.inTransit ?? '—'} 件（到货日期未提供，未计入可用天数）`] }] : []),
    ],
    facts: [...(result.facts ?? []), `评分卡最高：${best.name} ${best.total} 分（${best.grade}）`, ...(check ? [check] : [])],
    pending: [...(result.pending ?? []), '评分卡的服务、技术两项暂按 80 分计，需求部门评价后更新'],
    ...(urgent
      ? {
          suggestions: [...(result.suggestions ?? []), `走紧急采购：供应链经理先批先下单，24 小时内补齐书面审批（制度 4.2）；同时按 10.3 启动一级断供应急`],
          actions: [{ title: `${material.code} 紧急采购：供应链经理先批下单 ${best.name}，24 小时内补齐书面审批`, owner: '供应链经理', due: isoDate(addDays(ctx.now, 1)) }, ...(result.actions ?? [])].slice(0, 3),
        }
      : {}),
    artifacts: [...(result.artifacts ?? []), scorecardTable(scores)],
  };
}

/** Adds slow-moving stock, ABC class and the safety stock basis check to an inventory answer. */
export function enrichInventory(ctx: AgentCtx, result: AgentContext): AgentContext {
  if (ctx.deps.config.dataset !== 'official') return result;
  const rows = ctx.db.prepare('SELECT code, name, on_hand, unit_price, stale_days, abc FROM supply_materials ORDER BY stale_days DESC').all() as Row[];
  const value = (r: Row) => Number(r.on_hand) * Number(r.unit_price);
  const total = rows.reduce((s, r) => s + value(r), 0);
  const stale = rows.filter((r) => Number(r.stale_days) >= 180);
  const staleValue = stale.reduce((s, r) => s + value(r), 0);
  const checks = listMaterials(ctx.db, ctx.now)
    .map((m) => {
      const row = officialMaterial(ctx.db, m.code);
      return safetyCheck({ ...m, abc: String(row?.abc ?? ''), safetyStock: Number(row?.safety_stock ?? 0) });
    })
    .filter((c): c is string => c !== null);
  // Slow-moving stock answers its own question; elsewhere it stays in the blocks without crowding the facts.
  const staleQuestion = /呆滞|呆料|积压|不动|长期未用/.test(ctx.input);
  const staleTable = {
    kind: 'table' as const,
    title: '呆滞库存（≥180 天未动用）',
    columns: ['料号', '物料', '呆滞天数', '库存金额(万元)', 'ABC'],
    rows: stale.map((r) => [String(r.code), String(r.name), Number(r.stale_days), round(value(r) / 10000, 1), String(r.abc)]),
  };
  if (staleQuestion) {
    return {
      headline: `${stale.length} 项物料呆滞 ≥180 天，约 ${round(staleValue / 10000, 1)} 万元，占库存总额 ${round((staleValue / total) * 100, 1)}%（目标 ≤2%）`,
      blocks: [
        {
          title: '呆滞库存（≥180 天未动用，按天数）',
          lines: stale.slice(0, 10).map((r) => `${r.code} ${r.name}：${r.stale_days} 天，${round(value(r) / 10000, 1)} 万元，${r.abc} 类`),
        },
        { title: '依据', lines: [`${cite('SCM-2025-001-2.6')}：呆滞库存占比目标 ≤2%`, `${cite('SCM-2025-001-6.4')}：12 个月无动用的常规料优先内部代用、改制利用（季度评审）；可退换物料发现后 60 天内协商退换；无法利用的按报废流程处置；每月发布呆滞清单并按成因责任到模块`, `${cite('SCM-2025-001-3.4')}：呆滞风险料零安全库存、冻结补库，先用旧料`] },
      ],
      facts: [`呆滞（≥180 天）${stale.length} 项，约 ${round(staleValue / 10000, 1)} 万元，占库存总额 ${round((staleValue / total) * 100, 1)}%`, `呆滞最久：${stale[0]?.code} ${stale[0]?.name} ${stale[0]?.stale_days} 天`],
      pending: ['呆滞物料是否仍有在制订单或替代用途，需计划与工程确认'],
      suggestions: ['按 3.4 将呆滞风险料冻结补库、安全库存清零，优先消耗旧料', '按 6.4：可退换的 60 天内与供应商协商退换，其余优先内部代用或改制，无法利用的走报废'],
      actions: stale.length ? [{ title: `出具 ${stale.length} 项呆滞物料处置方案（金额最大的 ${stale.slice().sort((a, b) => value(b) - value(a)).slice(0, 3).map((r) => r.code).join('、')} 优先）`, owner: '供应链经理与财务', due: isoDate(addDays(ctx.now, 7)) }] : [],
      artifacts: [staleTable],
    };
  }
  return {
    ...result,
    blocks: [
      ...result.blocks,
      {
        title: '呆滞库存（≥180 天未动用）',
        lines: [
          `${stale.length} 项，金额约 ${round(staleValue / 10000, 1)} 万元，占库存总额 ${round((staleValue / total) * 100, 1)}%（${cite('SCM-2025-001-2.6')} 目标 ≤2%）`,
          ...stale.slice(0, 5).map((r) => `${r.code} ${r.name}：${r.stale_days} 天，${round(value(r) / 10000, 1)} 万元`),
        ],
      },
      ...(checks.length ? [{ title: '安全库存基准（制度 3.4）', lines: checks }] : []),
    ],
    facts: [...(result.facts ?? []), ...checks],
    suggestions: [...(result.suggestions ?? []), ...checks.map((c) => `按制度 3.4 上调 ${c.split(' ')[0]} 的安全库存参数`)],
  };
}

/**
 * Inventory alerts that follow the stock table. A material with a usage rate and a stockout date gets its own
 * stockout alert; the rest below safety stock are summed into one low-stock alert so the cockpit is not flooded.
 */
export function syncStockAlerts(deps: Deps): void {
  if (deps.config.dataset !== 'official') return;
  const materials = listMaterials(deps.db, deps.clock());
  const dated = materials.filter((m) => m.dailyUsage > 0 && materialStatus(m) === '缺料风险');
  syncStateAlerts(
    deps,
    'supply',
    'stockout_risk',
    dated.map((m) => ({
      key: m.code,
      title: `${m.code} ${m.name} 缺料风险`,
      summary: `库存 ${m.onHand} 件，日耗约 ${m.dailyUsage} 件，可用 ${round(m.cover, 1)} 天，预计 ${m.stockoutDate} 断料；安全库存 ${m.safetyStock} 件`,
      payload: { materialCode: m.code, materialName: m.name, coverDays: round(m.cover, 1), stockoutDate: m.stockoutDate, onHand: m.onHand, safetyStock: m.safetyStock, causes: ['缺料待料'] },
    })),
    '库存规则',
  );
  const low = materials.filter((m) => m.dailyUsage <= 0 && materialStatus(m) !== '正常').sort((a, b) => a.onHand / a.safetyStock - b.onHand / b.safetyStock);
  syncStateAlerts(
    deps,
    'supply',
    'low_stock',
    low.length
      ? [{
          key: 'plant',
          title: `${low.length} 项物料低于安全库存`,
          summary: low.slice(0, 6).map((m) => `${m.code} ${m.name} ${Math.round((m.onHand / m.safetyStock) * 100)}%`).join('；'),
          payload: { materials: low.map((m) => m.code), causes: ['缺料待料'] },
        }]
      : [],
    '库存规则',
  );
}
