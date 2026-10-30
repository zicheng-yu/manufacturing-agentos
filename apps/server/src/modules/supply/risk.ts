import type { TableArtifact } from '@agentos/shared';
import type { EventInput } from '../../core/events.ts';
import type { AgentContext } from '../../core/module.ts';
import { addDays } from '../../core/util.ts';
import { parseJson, type DB, type Row } from '../../db.ts';
import { listOrders, listSuppliers, type Supplier } from './data.ts';
import { matchSuppliers } from './lookup.ts';

export interface SupplierRisk {
  supplier: Supplier;
  score: number;
  level: '低' | '关注' | '高';
  delays: number;
  qualityCases: number;
  evidenceIds: string[];
  conflictIds: string[];
}

export const RISK_NOTE = '演示规则分（非违约概率）：准交率扣分 (1−准交率)×100，上限40；近30天每单延迟10分，上限30；关联品质案例每起15分，上限30。30分起关注，60分起高风险。同一订单/客诉只计一次；已解决记录仍计入30天历史。延迟按订单台账供应商归属，其他记录优先使用供应商ID；名称冲突单列待核。品质关联不代表供应商责任认定。';

/** Use the public event ledger, never another domain's private tables. */
export function supplierRisks(db: DB, now: Date): SupplierRisk[] {
  const orders = listOrders(db);
  const events = db.prepare(
    `SELECT * FROM events WHERE created_at >= ? AND created_at <= ? AND
     ((domain = 'supply' AND type = 'inbound_delay') OR
      (domain = 'quality' AND type IN ('customer_complaint', 'defect_recurrence'))) ORDER BY last_seen_at ASC`,
  ).all(addDays(now, -30).toISOString(), now.toISOString()) as Row[];
  const suppliers = listSuppliers(db);
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const buckets = new Map(suppliers.map((supplier) => [supplier.id, {
    delays: new Set<string>(), quality: new Set<string>(), evidenceIds: [] as string[], conflictIds: [] as string[],
  }]));
  const records = events.map((event) => ({ event, payload: parseJson<Record<string, unknown>>(event.payload_json, {}) }));
  const complaints = new Map<string, Record<string, unknown>>();
  for (const { event, payload } of records) {
    if (event.type === 'customer_complaint') complaints.set(String(payload.complaintId || event.id), payload);
  }
  for (const { event, payload: p } of records) {
    const order = event.domain === 'supply' ? ordersById.get(String(p.orderId ?? '')) : undefined;
    const original = event.domain === 'quality' ? complaints.get(String(p.complaintId || event.id)) : undefined;
    const attribution = original && (original.supplierId || original.supplier) ? original : p;
    const explicitId = typeof attribution.supplierId === 'string' && attribution.supplierId.trim() ? attribution.supplierId.trim() : null;
    const attributedNames = typeof attribution.supplier === 'string' ? matchSuppliers(suppliers, attribution.supplier) : [];
    const named = typeof p.supplier === 'string' ? matchSuppliers(suppliers, p.supplier) : [];
    // One complaint has one current attribution, shared with its recurrence records.
    // Order records and explicit supplier IDs take precedence over free-text names.
    const supplierId = order?.supplierId ?? explicitId ?? (attributedNames.length === 1 ? attributedNames[0].id : null);
    const bucket = supplierId ? buckets.get(supplierId) : undefined;
    if (!bucket) continue;
    if (event.domain === 'supply') bucket.delays.add(String(p.orderId || event.id));
    else bucket.quality.add(String(p.complaintId || event.id));
    bucket.evidenceIds.push(String(event.id));
    const nameConflict = typeof p.supplier === 'string' && p.supplier.trim() &&
      (named.length !== 1 || named[0].id !== supplierId);
    const reportedId = typeof p.supplierId === 'string' ? p.supplierId.trim() : null;
    if ((reportedId && reportedId !== supplierId) || nameConflict) bucket.conflictIds.push(String(event.id));
  }
  return suppliers.map((supplier): SupplierRisk => {
    const { delays, quality, evidenceIds, conflictIds } = buckets.get(supplier.id)!;
    const score = Math.round(Math.min(40, Math.max(0, 1 - supplier.onTimeRate) * 100) +
      Math.min(30, delays.size * 10) + Math.min(30, quality.size * 15));
    return { supplier, score, level: score >= 60 ? '高' : score >= 30 ? '关注' : '低', delays: delays.size, qualityCases: quality.size, evidenceIds, conflictIds };
  }).sort((a, b) => b.score - a.score || a.supplier.id.localeCompare(b.supplier.id));
}

export function riskTable(risks: SupplierRisk[]): TableArtifact {
  return {
    kind: 'table', title: '供应商风险评分',
    columns: ['供应商', '风险分(0–100)', '级别', '准交率', '近30天延迟单', '近30天关联品质案例', '归属待核(条)'],
    rows: risks.map((r) => [r.supplier.name, r.score, r.level, `${Math.round(r.supplier.onTimeRate * 100)}%`, r.delays, r.qualityCases, r.conflictIds.length]),
    note: RISK_NOTE,
  };
}

/** Artifacts are rendered separately; the model needs the same scoring basis in its textual context. */
export function riskBlocks(risks: SupplierRisk[]): AgentContext['blocks'] {
  return [
    { title: '供应商风险依据', lines: risks.map((r) => `${r.supplier.name}：${r.score}/100（${r.level}），准交率 ${Math.round(r.supplier.onTimeRate * 100)}%，近30天 ${r.delays} 单延迟、${r.qualityCases} 起关联品质案例${r.conflictIds.length ? `；${r.conflictIds.length} 条归属字段不一致，待核实` : ''}`) },
    { title: '风险计分口径', lines: [RISK_NOTE] },
  ];
}

export function riskEvents(risks: SupplierRisk[]): EventInput[] {
  return risks.filter((r) => r.score >= 30).map((r) => ({
    domain: 'supply', type: 'supplier_risk', severity: r.score >= 60 ? 'critical' : 'warn',
    dedupeKey: `supply:supplier-risk-score:${r.supplier.id}`,
    title: `${r.supplier.name} 供应风险${r.level === '高' ? '偏高' : '需关注'}`,
    summary: `规则风险分 ${r.score}/100，准交率 ${Math.round(r.supplier.onTimeRate * 100)}%，近30天 ${r.delays} 单延迟、${r.qualityCases} 起关联品质案例；需核实交付承诺与品质关联${r.conflictIds.length ? `；${r.conflictIds.length} 条事件的供应商归属字段不一致，待核实` : ''}`,
    payload: { supplierId: r.supplier.id, supplier: r.supplier.name, riskScore: r.score, delayOrders: r.delays, qualityCases: r.qualityCases, evidenceIds: r.evidenceIds, conflictIds: r.conflictIds },
    source: { channel: 'agent', actor: '供应商风险规则' },
  }));
}
