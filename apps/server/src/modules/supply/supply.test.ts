import type { AgentResult } from '@agentos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestEvent, listEvents } from '../../core/events.ts';
import { listTasks } from '../../core/memory.ts';
import type { ChatMessage } from '../../core/agents/providers.ts';
import { listSignals } from '../../core/signals.ts';
import { addDays } from '../../core/util.ts';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import { listMaterials, listQuotes, listSuppliers, normalizeQuotes } from './data.ts';
import { matchSuppliers, resolveMaterial, unknownSuppliers } from './lookup.ts';
import { supplierRisks } from './risk.ts';

let env: TestEnv;
beforeEach(() => { env = setup(); });
afterEach(() => { env.deps.db.close(); });

async function ask(question: string, conversationId?: string, agentId = 'supply.sourcing') {
  const cookie = await env.login('supply');
  const response = await env.send('POST', `/api/agents/${agentId}/turns`, { question, conversationId }, { Cookie: cookie });
  expect(response.status).toBe(200);
  return response.body as { conversation: { id: string }; turn: { id: string; result: AgentResult } };
}

const inventory = (question: string, conversationId?: string) => ask(question, conversationId, 'supply.inventory');

function complaint(id: string, at = env.deps.clock()) {
  return ingestEvent(env.deps, {
    domain: 'quality', type: 'customer_complaint', payload: { complaintId: id, supplier: '昆山精联电子', symptom: 'FPC 金手指氧化', category: 'FPC 接触不良' },
    source: { channel: 'bridge' }, at,
  });
}

describe('supply catalogue and follow-ups', () => {
  it('recognises supplier full names, short names and exact IDs without mixing similar brands', () => {
    const suppliers = listSuppliers(env.deps.db);
    for (const name of ['昆山精联电子', '昆山精联', '精联', 'sup-jl']) {
      expect(matchSuppliers(suppliers, name).map((s) => s.id)).toEqual(['SUP-JL']);
    }
    expect(matchSuppliers(suppliers, 'SUP-JL-NEW')).toEqual([]);
    expect(matchSuppliers(suppliers, '精铝').map((s) => s.id)).toEqual(['SUP-JM']);
  });

  it('does not classify known material names as unknown companies', () => {
    const suppliers = listSuppliers(env.deps.db);
    const materials = listMaterials(env.deps.db, env.deps.clock());
    for (const question of ['FPC 柔性电路板怎么比价', '光学胶材料找谁买', '精联的柔性板有货吗']) {
      expect(unknownSuppliers(suppliers, question, materials)).toEqual([]);
    }
    expect(unknownSuppliers(suppliers, 'FPC找新星电子报价', materials)).toEqual(['新星电子']);
    expect(unknownSuppliers(suppliers, 'FPC找新星报价', materials)).toEqual(['新星']);
    expect(unknownSuppliers(suppliers, 'FPC SUP-JL-NEW 有报价吗', materials)).toEqual(['SUP-JL-NEW']);
  });

  it('keeps a supplier/payment follow-up on the earlier material and evaluates the named alternative', async () => {
    const first = await ask('柔性板快断货了，几家供应商怎么选？');
    const follow = await ask('东莞德源要预付 30%，换无锡信创行不行？', first.conversation.id);
    expect(follow.turn.result.artifacts[0].title).toBe('FPC-1203 比价表');
    expect(follow.turn.result.answer).toContain('无锡信创柔电：含税 19.10 元');
    expect(follow.turn.result.answer).toContain('指定供应商核对');
  });

  it('does not reuse earlier stock or prices for an explicitly unknown SKU or new subject', async () => {
    const first = await ask('FPC-1203 怎么选？');
    for (const question of ['FPC-9999 有没有报价', '那 MLCC 电容呢', '电池找精联买怎么样']) {
      const response = await ask(question, first.conversation.id);
      expect(response.turn.result.title).toContain('未收录');
      expect(response.turn.result.artifacts[0].title).toBe('合格供应商');
      expect(response.turn.result.actions.some((a) => a.title.includes('询价'))).toBe(true);
    }
    const tasks = listTasks(env.deps.db, ['supply']);
    expect(tasks.some((t) => t.title.includes('FPC-9999') && t.title.includes('询价'))).toBe(true);
  });

  it('does not substitute an earlier material for an unknown explicit code even when the category matches', () => {
    const materials = listMaterials(env.deps.db, env.deps.clock());
    const suppliers = listSuppliers(env.deps.db);
    expect(resolveMaterial(materials, suppliers, 'FPC-9999', ['FPC-1203'], new Set())).toBeNull();
    expect(resolveMaterial(materials, suppliers, '那怎么选', ['FPC-1203', '那 MLCC 电容呢'], new Set())).toBeNull();
    expect(resolveMaterial(materials, suppliers, '驱动芯片', [], new Set())?.code).toBe('DIC-0870');
  });

  it('says a named supplier is unrecorded and creates an enquiry rather than inventing a quote', async () => {
    for (const question of ['FPC-1203 找新星电子报价', 'FPC-1203 SUP-NEW 有没有报价']) {
      const response = await ask(question);
      expect(response.turn.result.title).toContain('未收录');
      expect(response.turn.result.artifacts[0].title).toBe('合格供应商');
      expect(response.turn.result.actions[0].title).toContain('询价');
    }
  });

  it('distinguishes a known supplier with no quote for the selected material', async () => {
    const response = await ask('FPC-1203 找芯平有报价吗？');
    expect(response.turn.result.pending.join(' ')).toContain('上海芯平半导体暂无 FPC-1203 报价');
    expect(response.turn.result.actions.some((a) => a.title.includes('向上海芯平半导体询价 FPC-1203'))).toBe(true);
  });

  it('answers a supplier-only question without choosing a material', async () => {
    for (const question of ['精联风险怎么样？', '东莞德源电路风险怎么样？']) {
      const response = await ask(question);
      expect(response.turn.result.artifacts[0].title).toBe('供应商风险评分');
      expect(response.turn.result.artifacts[0].kind).toBe('table');
      expect(response.turn.result.actions).toEqual([]);
    }
  });

  it('lets an explicit supplier-risk question override the earlier sourcing topic', async () => {
    const first = await ask('FPC-1203 有没有替代货源');
    const response = await ask('精联风险怎么样？', first.conversation.id);
    const table = response.turn.result.artifacts[0];
    expect(table.title).toBe('供应商风险评分');
    expect(table.kind === 'table' && table.rows.map((r) => r[0])).toEqual(['昆山精联电子']);
  });

  it('treats a supplier-list question as a catalogue request rather than an unknown company', async () => {
    for (const question of ['供应商有哪些？', '所有供应商风险怎么样？']) {
      const response = await ask(question);
      expect(response.turn.result.title).not.toContain('未收录');
      const table = response.turn.result.artifacts[0];
      expect(table.kind === 'table' && table.rows.length).toBe(9);
      expect(response.turn.result.actions.every((a) => !a.title.includes('询价'))).toBe(true);
    }
  });
});

describe('quote normalization', () => {
  it('compares three suppliers with tax conversion, MOQ excess, total price and shortage gap', () => {
    const ranked = normalizeQuotes(listQuotes(env.deps.db, 'FPC-1203'), 2700, 1.7);
    expect(ranked).toHaveLength(3);
    expect(ranked[0].supplierId).toBe('SUP-DY');
    const xc = ranked.find((q) => q.supplierId === 'SUP-XC')!;
    expect(xc.priceWithTax).toBeCloseTo(19.097, 3);
    expect(xc.orderQty).toBe(5000);
    expect(xc.orderTotal).toBeCloseTo(95485);
    expect(xc.gapDays).toBeCloseTo(8.3);
    expect(xc.flags.join(' ')).toContain('多采 2300');
    const jl = ranked.find((q) => q.supplierId === 'SUP-JL')!;
    expect(jl.priceWithTax).toBe(18.6);
    expect(jl.orderQty).toBe(2700);
    expect(ranked[0].flags.join(' ')).toContain('财务确认');
  });
});

describe('inventory selection and purchasing actions', () => {
  it('limits inventory, actions and derived events to the requested material', async () => {
    env.deps.db.prepare("UPDATE supply_materials SET on_hand = 0 WHERE code = 'FPC-1203'").run();
    const response = await inventory('光学胶库存怎么样？');
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.map((r) => r[0])).toEqual(['OCA-0300']);
    expect(response.turn.result.eventIds).toEqual([]);
    expect(response.turn.result.actions).toEqual([]);
    expect(response.turn.result.answer).not.toContain('FPC-1203');
  });

  it('does not replace an unknown material with a whole-catalogue stock answer or emit unrelated risks', async () => {
    for (const question of ['MLCC 电容库存还有多少？', 'FPC-9999 库存', '新星电子供的物料库存']) {
      const response = await inventory(question);
      expect(response.turn.result.title).toContain('未收录');
      expect(response.turn.result.artifacts.every((a) => a.title !== '补货建议单')).toBe(true);
      expect(response.turn.result.eventIds).toEqual([]);
      expect(response.turn.result.actions.some((a) => a.title.includes('询价'))).toBe(true);
    }
  });

  it('keeps a material follow-up scoped and lets an explicit overview reset that scope', async () => {
    const first = await inventory('柔性板库存');
    const follow = await inventory('那还需要补多少？', first.conversation.id);
    const scoped = follow.turn.result.artifacts[0];
    expect(scoped.kind === 'table' && scoped.rows.map((r) => r[0])).toEqual(['FPC-1203']);
    const overview = await inventory('请列出所有物料库存', first.conversation.id);
    const table = overview.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.length).toBe(9);
  });

  it('keeps all three existing inventory starters working as catalogue overviews', async () => {
    for (const question of ['哪些物料快缺料了？', '本周需要补哪些货', '延迟在途单对产线有什么影响']) {
      const response = await inventory(question);
      const table = response.turn.result.artifacts[0];
      expect(table.kind === 'table' && table.rows.length).toBe(9);
    }
  });

  it('shows every explicit known SKU and rejects a request containing an unknown SKU', async () => {
    const response = await inventory('fpc-1203 和 DIC-0870 的库存');
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.map((r) => r[0]).sort()).toEqual(['DIC-0870', 'FPC-1203']);
    const unknown = await inventory('FPC-1203 和 FPC-9999 的库存');
    expect(unknown.turn.result.title).toContain('未收录');
    expect(unknown.turn.result.eventIds).toEqual([]);
  });

  it('filters supplier stock by its current materials and distinguishes quote-only suppliers', async () => {
    const first = await inventory('驱动芯片库存');
    const response = await inventory('那精联供的物料库存呢？', first.conversation.id);
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.map((r) => r[0]).sort()).toEqual(['FPC-1025', 'FPC-1203']);
    const quoteOnly = await inventory('德源库存');
    expect(quoteOnly.turn.result.title).toContain('没有关联的现供物料');
    expect(quoteOnly.turn.result.artifacts).toEqual([]);
  });

  it('expedites already sufficient late orders instead of creating a zero-quantity purchase', async () => {
    env.deps.db.prepare("UPDATE supply_orders SET qty = 10000, eta = ?, delay_days = 7, status = '延迟' WHERE id = 'PO-2611'")
      .run(addDays(env.deps.clock(), 8).toISOString().slice(0, 10));
    const response = await inventory('FPC-1203 库存和补货');
    expect(response.turn.result.answer).toContain('无需重复追加采购');
    expect(response.turn.result.actions[0].title).toContain('加急现有在途订单');
    expect(response.turn.result.actions.every((a) => !/补货 0\b/.test(a.title))).toBe(true);
    const sourcing = await ask('FPC-1203 有没有替代货源');
    expect(sourcing.turn.result.title).toContain('避免重复采购');
    expect(sourcing.turn.result.actions.some((a) => a.title.includes('加急'))).toBe(true);
    expect(sourcing.turn.result.actions.every((a) => !a.title.includes('下达'))).toBe(true);
  });

  it('does not display a purchase quantity for healthy inventory or create purchase tasks', async () => {
    const response = await inventory('光学胶库存');
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows[0][7]).toBe(0);
    expect(response.turn.result.actions).toEqual([]);
  });

  it('distinguishes the requested FPC dimensions and rejects an unrecorded dimension', async () => {
    const response = await inventory('10.25 英寸的 FPC 库存');
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.map((r) => r[0])).toEqual(['FPC-1025']);
    const unknown = await inventory('15 英寸的 FPC 库存');
    expect(unknown.turn.result.title).toContain('未收录');
    expect(unknown.turn.result.eventIds).toEqual([]);
    const conflict = await inventory('FPC-1203 10.25 英寸库存');
    expect(conflict.turn.result.artifacts.every((a) => a.title !== '补货建议单')).toBe(true);
  });

  it('supports common stock follow-ups without losing the selected material', async () => {
    const first = await inventory('驱动芯片库存');
    const response = await inventory('那库存还够几天？', first.conversation.id);
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.map((r) => r[0])).toEqual(['DIC-0870']);
  });
});

describe('supplier risk evidence and signals', () => {
  it('counts one delay per order and one quality case per complaint even on duplicate or recurrence reports', () => {
    complaint('C-TEST');
    complaint('C-TEST');
    for (let i = 0; i < 2; i++) {
      ingestEvent(env.deps, { domain: 'supply', type: 'inbound_delay', payload: { orderId: 'PO-2611', delayDays: 1 }, source: { channel: 'bridge' } });
      env.advance(11);
    }
    const risk = supplierRisks(env.deps.db, env.deps.clock()).find((r) => r.supplier.id === 'SUP-JL')!;
    expect(risk.delays).toBe(1);
    expect(risk.qualityCases).toBe(1);
    expect(risk.score).toBe(39);
    const events = listEvents(env.deps, { domains: ['supply'] }).filter((e) => e.type === 'supplier_risk');
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(1);
    expect(events[0].payload.riskScore).toBe(39);
    expect(events[0].payload.evidenceIds).toEqual(expect.arrayContaining(risk.evidenceIds));
    expect(listSignals(env.deps, ['supply']).some((s) => s.ruleId === 'supply-supplier-risk')).toBe(true);
  });

  it('uses a 30-day history window including resolved records and excludes future records', () => {
    complaint('OLD', addDays(env.deps.clock(), -31));
    complaint('FUTURE', addDays(env.deps.clock(), 1));
    const recent = complaint('RECENT');
    env.deps.db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(recent.event.id);
    const risk = supplierRisks(env.deps.db, env.deps.clock()).find((r) => r.supplier.id === 'SUP-JL')!;
    expect(risk.qualityCases).toBe(1);
    expect(risk.score).toBe(29);
  });

  it('does not attribute an unlinked material complaint to a supplier', () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'UNLINKED', materialCode: 'FPC-1203', symptom: '包装破损' }, source: { channel: 'bridge' } });
    expect(supplierRisks(env.deps.db, env.deps.clock()).find((r) => r.supplier.id === 'SUP-JL')!.qualityCases).toBe(0);
  });

  it('publishes a deduplicated risk event and signal when the agent observes linked quality evidence', async () => {
    complaint('C-ONE');
    complaint('C-TWO');
    const response = await ask('精联风险怎么样？');
    expect(response.turn.result.eventIds).toHaveLength(1);
    const again = await ask('精联风险怎么样？');
    expect(again.turn.result.eventIds).toEqual(response.turn.result.eventIds);
    const risk = listEvents(env.deps, { domains: ['supply'] }).find((e) => e.type === 'supplier_risk')!;
    expect(risk.count).toBe(1);
    expect(risk.payload.riskScore).toBe(44);
    expect(risk.payload.evidenceIds).toBeInstanceOf(Array);
    expect(listSignals(env.deps, ['supply']).some((s) => s.eventIds.includes(risk.id))).toBe(true);
  });

  it('updates a computed score with new evidence while keeping an external risk report intact', async () => {
    complaint('C-ONE');
    ingestEvent(env.deps, { domain: 'supply', type: 'inbound_delay', payload: { orderId: 'PO-2611', delayDays: 1 }, source: { channel: 'bridge' } });
    const manual = ingestEvent(env.deps, { domain: 'supply', type: 'supplier_risk', summary: '人工报告：产能紧张待核', payload: { supplierId: 'SUP-JL' }, source: { channel: 'manual' } });
    complaint('C-TWO');
    await ask('精联风险怎么样？');
    const events = listEvents(env.deps, { domains: ['supply'] }).filter((e) => e.type === 'supplier_risk');
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.id === manual.event.id)!.summary).toBe('人工报告：产能紧张待核');
    expect(events.find((e) => e.id !== manual.event.id)!.payload.riskScore).toBe(54);
  });

  it('caps each scoring component and the total at 100', () => {
    env.deps.db.prepare("UPDATE supply_suppliers SET on_time_rate = 0 WHERE id = 'SUP-JL'").run();
    for (let i = 0; i < 5; i++) {
      complaint(`C-${i}`);
      ingestEvent(env.deps, { domain: 'supply', type: 'inbound_delay', payload: { orderId: `EXTERNAL-${i}`, supplierId: 'SUP-JL' }, source: { channel: 'bridge' } });
    }
    const risk = supplierRisks(env.deps.db, env.deps.clock()).find((r) => r.supplier.id === 'SUP-JL')!;
    expect(risk.score).toBe(100);
    expect(risk.level).toBe('高');
  });

  it('does not double-attribute conflicting supplier fields in quality evidence', () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: {
      complaintId: 'CONFLICT', supplierId: 'SUP-XC', supplier: '昆山精联电子', symptom: '包装破损',
    }, source: { channel: 'bridge' } });
    const risks = supplierRisks(env.deps.db, env.deps.clock());
    expect(risks.find((r) => r.supplier.id === 'SUP-XC')!.qualityCases).toBe(1);
    expect(risks.find((r) => r.supplier.id === 'SUP-XC')!.conflictIds).toHaveLength(1);
    expect(risks.find((r) => r.supplier.id === 'SUP-JL')!.qualityCases).toBe(0);
    env.advance(11);
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: {
      complaintId: 'CONFLICT', supplierId: 'SUP-JL', supplier: '昆山精联电子', symptom: '包装破损',
    }, source: { channel: 'bridge' } });
    const corrected = supplierRisks(env.deps.db, env.deps.clock());
    expect(corrected.find((r) => r.supplier.id === 'SUP-JL')!.qualityCases).toBe(1);
    expect(corrected.find((r) => r.supplier.id === 'SUP-XC')!.qualityCases).toBe(0);
  });

  it('uses the recorded order supplier instead of a conflicting delay-report supplier', () => {
    ingestEvent(env.deps, { domain: 'supply', type: 'inbound_delay', payload: {
      orderId: 'PO-2611', delayDays: 1, supplierId: 'SUP-XC',
    }, source: { channel: 'bridge' } });
    const risks = supplierRisks(env.deps.db, env.deps.clock());
    expect(risks.find((r) => r.supplier.id === 'SUP-JL')!.delays).toBe(1);
    expect(risks.find((r) => r.supplier.id === 'SUP-JL')!.conflictIds).toHaveLength(1);
    expect(risks.find((r) => r.supplier.id === 'SUP-XC')!.delays).toBe(0);
  });

  it('does not guess a known supplier from a name when the report gives an unknown explicit ID', () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: {
      complaintId: 'UNKNOWN-ID', supplierId: 'SUP-NOT-RECORDED', supplier: '昆山精联电子', symptom: '包装破损',
    }, source: { channel: 'bridge' } });
    expect(supplierRisks(env.deps.db, env.deps.clock()).every((r) => r.qualityCases === 0)).toBe(true);
  });

  it('keeps a recurrence linked to the reported complaint supplier when the historical case names another one', () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: {
      complaintId: 'RECURRENCE-CONFLICT', supplierId: 'SUP-XC', supplier: '无锡信创柔电', symptom: 'FPC 金手指氧化', category: 'FPC 接触不良',
    }, source: { channel: 'bridge' } });
    expect(listEvents(env.deps, { domains: ['quality'] }).some((e) => e.type === 'defect_recurrence' && e.payload.complaintId === 'RECURRENCE-CONFLICT')).toBe(true);
    const risks = supplierRisks(env.deps.db, env.deps.clock());
    expect(risks.find((r) => r.supplier.id === 'SUP-XC')!.qualityCases).toBe(1);
    expect(risks.find((r) => r.supplier.id === 'SUP-JL')!.qualityCases).toBe(0);
  });
});

describe('supply context through model and fallback paths', () => {
  it('includes the computed score, scoring basis and attribution conflicts in the model context', async () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: {
      complaintId: 'MODEL-CONFLICT', supplierId: 'SUP-JL', supplier: '无锡信创柔电', symptom: '包装破损',
    }, source: { channel: 'bridge' } });
    let captured: ChatMessage[] = [];
    env.deps.provider = {
      mode: 'llm', model: 'test-provider',
      async complete(messages) {
        captured = messages;
        return JSON.stringify({ title: '供应商分析', answer: '按给定规则评分，先核实归属字段。' });
      },
    };
    const response = await ask('精联风险怎么样？');
    const context = captured.at(-1)!.content;
    expect(context).toContain('29/100');
    expect(context).toContain('近30天每单延迟10分');
    expect(context).toContain('1 条归属字段不一致，待核实');
    expect(response.turn.result.pending.join(' ')).toContain('归属字段不一致');
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows[0][6]).toBe(1);
  });

  it('preserves scoped inventory and valid actions when the model provider fails', async () => {
    env.deps.provider = { mode: 'llm', model: 'test-provider', async complete() { throw new Error('test timeout'); } };
    const response = await inventory('驱动芯片库存');
    const table = response.turn.result.artifacts[0];
    expect(table.kind === 'table' && table.rows.map((r) => r[0])).toEqual(['DIC-0870']);
    expect(response.turn.result.pending.join(' ')).toContain('已按规则分析作答');
    expect(response.turn.result.actions).toEqual([]);
  });
});
