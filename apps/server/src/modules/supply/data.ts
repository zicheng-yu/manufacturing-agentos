import type { DB, Row } from '../../db.ts';

export interface Material {
  code: string;
  name: string;
  category: string;
  unit: string;
  line: string;
  onHand: number;
  /** Quantity on orders that are not delayed. */
  inTransit: number;
  dailyUsage: number;
  safetyDays: number;
  supplierId: string;
  unitPrice: number;
}

export interface Order {
  id: string;
  materialCode: string;
  supplierId: string;
  qty: number;
  eta: string;
  delayDays: number;
  status: string;
}

export interface Quote {
  id: string;
  materialCode: string;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  taxIncluded: boolean;
  moq: number;
  leadTimeDays: number;
  paymentTerms: string;
  onTimeRate: number;
}

export const VAT_RATE = 0.13;

export function listOrders(db: DB): Order[] {
  return (db.prepare('SELECT * FROM supply_orders ORDER BY eta').all() as Row[]).map((r) => ({
    id: String(r.id),
    materialCode: String(r.material_code),
    supplierId: String(r.supplier_id),
    qty: Number(r.qty),
    eta: String(r.eta),
    delayDays: Number(r.delay_days),
    status: String(r.status),
  }));
}

export function listMaterials(db: DB): Material[] {
  const onTime = new Map<string, number>();
  for (const o of listOrders(db)) {
    if (o.status === '在途') onTime.set(o.materialCode, (onTime.get(o.materialCode) ?? 0) + o.qty);
  }
  return (db.prepare('SELECT * FROM supply_materials ORDER BY line, code').all() as Row[]).map((r) => ({
    code: String(r.code),
    name: String(r.name),
    category: String(r.category),
    unit: String(r.unit),
    line: String(r.line),
    onHand: Number(r.on_hand),
    inTransit: onTime.get(String(r.code)) ?? 0,
    dailyUsage: Number(r.daily_usage),
    safetyDays: Number(r.safety_days),
    supplierId: String(r.supplier_id),
    unitPrice: Number(r.unit_price),
  }));
}

export function coverDays(m: Material): number {
  return m.dailyUsage > 0 ? (m.onHand + m.inTransit) / m.dailyUsage : Infinity;
}

export function materialStatus(m: Material): '正常' | '低于安全库存' | '缺料风险' {
  const days = coverDays(m);
  if (days < m.safetyDays * 0.6) return '缺料风险';
  if (days < m.safetyDays) return '低于安全库存';
  return '正常';
}

export function supplierName(db: DB, id: string): string {
  const row = db.prepare('SELECT name FROM supply_suppliers WHERE id = ?').get(id) as Row | undefined;
  return row ? String(row.name) : id;
}

export function listQuotes(db: DB, materialCode: string): Quote[] {
  const rows = db
    .prepare(
      `SELECT q.*, s.name AS supplier_name, s.on_time_rate FROM supply_quotes q
       JOIN supply_suppliers s ON s.id = q.supplier_id WHERE q.material_code = ?`,
    )
    .all(materialCode) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    materialCode: String(r.material_code),
    supplierId: String(r.supplier_id),
    supplierName: String(r.supplier_name),
    unitPrice: Number(r.unit_price),
    taxIncluded: Number(r.tax_included) === 1,
    moq: Number(r.moq),
    leadTimeDays: Number(r.lead_time_days),
    paymentTerms: String(r.payment_terms),
    onTimeRate: Number(r.on_time_rate),
  }));
}

export interface NormalizedQuote extends Quote {
  priceWithTax: number;
  orderQty: number;
  orderTotal: number;
  /** Days the line runs short before this supplier can deliver. */
  gapDays: number;
  score: number;
  flags: string[];
}

/**
 * Put quotes on one basis: tax-inclusive unit price, order quantity rounded up to MOQ,
 * and the shortage gap given current stock cover. Lower score is better.
 */
export function normalizeQuotes(quotes: Quote[], need: number, cover: number): NormalizedQuote[] {
  const normalized = quotes.map((q) => {
    const priceWithTax = q.taxIncluded ? q.unitPrice : q.unitPrice * (1 + VAT_RATE);
    const orderQty = Math.max(need, q.moq);
    const gapDays = Math.max(0, q.leadTimeDays - cover);
    const flags: string[] = [];
    if (!q.taxIncluded) flags.push('报价不含税，已按 13% 增值税换算');
    if (q.moq > need) flags.push(`MOQ ${q.moq} 高于需求 ${need}，多采 ${q.moq - need}`);
    if (/预付/.test(q.paymentTerms)) flags.push(`付款条件「${q.paymentTerms}」需财务确认`);
    if (gapDays > 0) flags.push(`交期 ${q.leadTimeDays} 天，比可用库存多 ${Math.ceil(gapDays)} 天`);
    return { ...q, priceWithTax, orderQty, orderTotal: priceWithTax * orderQty, gapDays, score: 0, flags };
  });
  const minPrice = Math.min(...normalized.map((q) => q.priceWithTax));
  for (const q of normalized) {
    // Each day of shortage weighs like a 5% price premium; poor on-time delivery adds risk.
    q.score = q.priceWithTax / minPrice + q.gapDays * 0.05 + (1 - q.onTimeRate) * 0.5;
  }
  return normalized.sort((a, b) => a.score - b.score);
}
