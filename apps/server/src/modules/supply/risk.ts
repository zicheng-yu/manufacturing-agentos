import type { TableArtifact } from '@agentos/shared';
import type { EventInput } from '../../core/events.ts';
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
}

export const RISK_NOTE = '演示规则分（非违约概率）：准交率扣分 (1−准交率)×100，上限40；近30天每单延迟10分，上限30；关联品质案例每起15分，上限30。30分起关注，60分起高风险。同一订单/客诉只计一次；已解决记录仍计入30天历史。品质关联需核实，不代表供应商责任认定。';

/** Use the public event ledger, never another domain's private tables. */
export function supplierRisks(db: DB, now: Date): SupplierRisk[] {
  const orders = listOrders(db);
  const events = db.prepare(
    `SELECT * FROM events WHERE created_at >= ? AND created_at <= ? AND
     ((domain = 'supply' AND type = 'inbound_delay') OR
      (domain = 'quality' AND type IN ('customer_complaint', 'defect_recurrence')))`,
  ).all(addDays(now, -30).toISOString(), now.toISOString()) as Row[];
  const suppliers = listSuppliers(db);
  return suppliers.map((supplier): SupplierRisk => {
    const delays = new Set<string>();
    const quality = new Set<string>();
    const evidenceIds: string[] = [];
    for (const event of events) {
      const p = parseJson<Record<string, unknown>>(event.payload_json, {});
      const order = orders.find((o) => o.id === p.orderId);
      const linked = p.supplierId === supplier.id ||
        (event.domain === 'supply' && order?.supplierId === supplier.id) ||
        (typeof p.supplier === 'string' && matchSuppliers(suppliers, p.supplier).some((s) => s.id === supplier.id));
      if (!linked) continue;
      if (event.domain === 'supply') delays.add(String(p.orderId ?? event.id));
      else quality.add(String(p.complaintId ?? event.id));
      evidenceIds.push(String(event.id));
    }
    const score = Math.round(Math.min(40, Math.max(0, 1 - supplier.onTimeRate) * 100) +
      Math.min(30, delays.size * 10) + Math.min(30, quality.size * 15));
    return { supplier, score, level: score >= 60 ? '高' : score >= 30 ? '关注' : '低', delays: delays.size, qualityCases: quality.size, evidenceIds };
  }).sort((a, b) => b.score - a.score || a.supplier.id.localeCompare(b.supplier.id));
}

export function riskTable(risks: SupplierRisk[]): TableArtifact {
  return {
    kind: 'table', title: '供应商风险评分',
    columns: ['供应商', '风险分(0–100)', '级别', '准交率', '近30天延迟单', '近30天关联品质案例'],
    rows: risks.map((r) => [r.supplier.name, r.score, r.level, `${Math.round(r.supplier.onTimeRate * 100)}%`, r.delays, r.qualityCases]),
    note: RISK_NOTE,
  };
}

export function riskEvents(risks: SupplierRisk[]): EventInput[] {
  return risks.filter((r) => r.score >= 30).map((r) => ({
    domain: 'supply', type: 'supplier_risk', severity: r.score >= 60 ? 'critical' : 'warn',
    dedupeKey: `supply:supplier-risk-score:${r.supplier.id}`,
    title: `${r.supplier.name} 供应风险${r.level === '高' ? '偏高' : '需关注'}`,
    summary: `规则风险分 ${r.score}/100，准交率 ${Math.round(r.supplier.onTimeRate * 100)}%，近30天 ${r.delays} 单延迟、${r.qualityCases} 起关联品质案例；需核实交付承诺与品质关联`,
    payload: { supplierId: r.supplier.id, supplier: r.supplier.name, riskScore: r.score, delayOrders: r.delays, qualityCases: r.qualityCases, evidenceIds: r.evidenceIds },
    source: { channel: 'agent', actor: '供应商风险规则' },
  }));
}
