import type { DB, Row } from '../../db.ts';
import { addDays, isoDate, keywordScore } from '../../core/util.ts';

export interface Order {
  id: string;
  materialCode: string;
  supplierId: string;
  qty: number;
  eta: string;
  delayDays: number;
  status: string;
}

export interface Material {
  code: string;
  name: string;
  /** Words people use for it, e.g. 柔性板 for FPC. */
  aliases: string;
  category: string;
  unit: string;
  line: string;
  onHand: number;
  /** Quantity on all open orders, delayed ones included. */
  inTransit: number;
  orders: Order[];
  dailyUsage: number;
  safetyDays: number;
  /** Safety stock as a quantity; the official pack gives this instead of days. 0 when unknown. */
  safetyStock: number;
  supplierId: string;
  unitPrice: number;
  /** Days until stock runs out, counting each open order on its (possibly delayed) arrival date. */
  cover: number;
  /** Date stock runs out within the horizon, or null. */
  stockoutDate: string | null;
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
const HORIZON_DAYS = 60;

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

/** Walk the stock forward day by day: consume daily usage, add each order on its arrival day. */
export function runOut(onHand: number, dailyUsage: number, arrivals: { day: number; qty: number }[]): number {
  if (dailyUsage <= 0) return Infinity;
  let stock = onHand;
  let t = 0;
  for (const a of [...arrivals].sort((x, y) => x.day - y.day)) {
    const day = Math.max(a.day, 0);
    if (t + stock / dailyUsage < day) return t + stock / dailyUsage;
    stock -= (day - t) * dailyUsage;
    stock += a.qty;
    t = day;
  }
  return Math.min(t + stock / dailyUsage, HORIZON_DAYS);
}

export function listMaterials(db: DB, now: Date): Material[] {
  const orders = listOrders(db).filter((o) => o.status !== '已到货');
  const today = Date.parse(isoDate(now));
  return (db.prepare('SELECT * FROM supply_materials ORDER BY line, code').all() as Row[]).map((r) => {
    const code = String(r.code);
    const mine = orders.filter((o) => o.materialCode === code);
    const dailyUsage = Number(r.daily_usage);
    const onHand = Number(r.on_hand);
    const cover = runOut(
      onHand,
      dailyUsage,
      mine.map((o) => ({ day: (Date.parse(o.eta) - today) / 86_400_000, qty: o.qty })),
    );
    return {
      code,
      name: String(r.name),
      aliases: String(r.aliases ?? ''),
      category: String(r.category),
      unit: String(r.unit),
      line: String(r.line),
      onHand,
      inTransit: mine.reduce((s, o) => s + o.qty, 0),
      orders: mine,
      dailyUsage,
      safetyDays: Number(r.safety_days),
      safetyStock: Number(r.safety_stock ?? 0),
      supplierId: String(r.supplier_id),
      unitPrice: Number(r.unit_price),
      cover,
      stockoutDate: cover < HORIZON_DAYS ? isoDate(addDays(now, Math.floor(cover))) : null,
    };
  });
}

export function coverDays(m: Material): number {
  return m.cover;
}

export function materialStatus(m: Material): '正常' | '低于安全库存' | '缺料风险' {
  // Without a usage rate (most of the official pack), judge stock against the safety quantity instead.
  if (m.dailyUsage <= 0) {
    if (m.safetyStock <= 0) return '正常';
    if (m.onHand < m.safetyStock * 0.6) return '缺料风险';
    return m.onHand < m.safetyStock ? '低于安全库存' : '正常';
  }
  if (m.cover < m.safetyDays * 0.6) return '缺料风险';
  if (m.cover < m.safetyDays) return '低于安全库存';
  return '正常';
}

/** How full stock is relative to its safety level: cover ÷ safety days, or quantity ÷ safety stock without a usage rate. */
export function stockRatio(m: Material): number {
  if (m.dailyUsage > 0) return m.safetyDays > 0 ? m.cover / m.safetyDays : Infinity;
  return m.safetyStock > 0 ? m.onHand / m.safetyStock : Infinity;
}

/** "可用 3 天，安全 11 天" when usage is known, otherwise the quantity against safety stock. */
export function coverText(m: Material): string {
  if (m.dailyUsage > 0) {
    return `可用 ${Math.round(m.cover * 10) / 10} 天（安全 ${m.safetyDays} 天）${m.stockoutDate && materialStatus(m) !== '正常' ? `，预计 ${m.stockoutDate} 断料` : ''}`;
  }
  if (m.safetyStock > 0) return `为安全库存 ${m.safetyStock} ${m.unit}的 ${Math.round((m.onHand / m.safetyStock) * 100)}%（未提供日耗，按数量判断）`;
  return '未设定安全库存';
}

export function matchesDimensions(material: Material, text: string): boolean {
  const dimensions = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:英寸|寸)/g)].map((match) => Number(match[1]));
  const sizes = [...material.name.matchAll(/(\d+(?:\.\d+)?)\s*(?:英寸|寸)/g)].map((match) => Number(match[1]));
  return dimensions.every((size) => sizes.includes(size));
}

/** Best material for a question, or null when nothing in the catalogue matches. */
export function matchMaterial(materials: Material[], text: string, preferCodes: Set<string> = new Set()): Material | null {
  const upper = text.toUpperCase();
  const scored = materials
    .filter((m) => matchesDimensions(m, text))
    .map((m) => ({
      m,
      score:
        (upper.includes(m.code) ? 100 : 0) +
        2 * m.aliases.split(/\s+/).filter((a) => a && upper.includes(a.toUpperCase())).length * 10 +
        keywordScore(text, `${m.name} ${m.category}`),
    }))
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored.filter((s) => s.score === scored[0].score).map((s) => s.m);
  return best.find((m) => preferCodes.has(m.code)) ?? best[0];
}

export function supplierName(db: DB, id: string): string {
  if (!id) return '未登记';
  const row = db.prepare('SELECT name FROM supply_suppliers WHERE id = ?').get(id) as Row | undefined;
  return row ? String(row.name) : id;
}

export interface Supplier {
  id: string;
  name: string;
  category: string;
  region: string;
  rating: string;
  leadTimeDays: number;
  onTimeRate: number;
  note: string;
}

export function listSuppliers(db: DB): Supplier[] {
  return (db.prepare('SELECT * FROM supply_suppliers ORDER BY category, name').all() as Row[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    category: String(r.category),
    region: String(r.region),
    rating: String(r.rating),
    leadTimeDays: Number(r.lead_time_days),
    onTimeRate: Number(r.on_time_rate),
    note: String(r.note),
  }));
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
