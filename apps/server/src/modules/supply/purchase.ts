import type { AgentContext, AgentCtx } from '../../core/module.ts';
import { listQuotes, normalizeQuotes, supplierName, type Material, type Supplier } from './data.ts';
import { dateAfter, localDate, type PurchaseRequest } from './request.ts';
import { riskBlocks, riskEvents, riskTable, supplierRisks } from './risk.ts';

/** A buyer's explicit request is distinct from the platform's inferred replenishment target. */
export function purchaseContext(ctx: AgentCtx, material: Material, request: PurchaseRequest, requestedSuppliers: Supplier[]): AgentContext {
  const { db, now } = ctx;
  const today = localDate(now);
  const due = request.deadline?.date ?? dateAfter(today, 1);
  const errors = [...request.errors];
  if (request.quantity?.unit && request.quantity.unit !== material.unit) {
    errors.push(`数量单位「${request.quantity.unit}」与 ${material.code} 的库存单位「${material.unit}」不同，请核实换算关系`);
  }
  const summary = {
    title: '本次采购需求',
    lines: [
      `${material.code} ${material.name}`,
      request.quantity ? `本次指定数量 ${request.quantity.value} ${request.quantity.unit ?? material.unit}` : '本次采购数量尚未明确',
      request.deadline ? `最晚 ${request.deadline.date} 到货，距今天 ${request.deadline.days} 个自然日（中国标准时间）` : '本次最晚到货日期尚待确认',
    ],
  };
  if (errors.length) {
    return {
      headline: '采购需求存在歧义，请先核实数量与期限',
      blocks: [summary], pending: errors,
      actions: [{ title: `${material.code} 核实采购数量、单位与到货期限后再比价`, owner: '供应链经理', due: today }],
    };
  }
  if (!request.quantity) {
    return {
      headline: `${material.code} 已识别到货期限，请补充本次采购数量`,
      blocks: [summary], pending: ['请明确本次采购数量，不能用默认补货量替代用户需求', ...request.pending],
      actions: [{ title: `${material.code} 确认本次采购数量与可分配库存`, owner: '供应链经理', due: today }],
    };
  }

  const quantity = request.quantity.value;
  const quoteRows = listQuotes(db, material.code);
  const deadline = request.deadline;
  const ranked = normalizeQuotes(quoteRows, quantity, material.cover).map((q) => ({
    ...q,
    eta: dateAfter(today, q.leadTimeDays),
    lateDays: deadline ? Math.max(0, q.leadTimeDays - deadline.days) : null,
    excess: q.orderQty - quantity,
  })).sort((a, b) => {
    if (deadline) {
      const aLate = a.lateDays! > 0;
      const bLate = b.lateDays! > 0;
      if (aLate !== bLate) return aLate ? 1 : -1;
      if (aLate && a.lateDays !== b.lateDays) return a.lateDays! - b.lateDays!;
    }
    return a.orderTotal - b.orderTotal || b.onTimeRate - a.onTimeRate || a.leadTimeDays - b.leadTimeDays;
  });
  const feasible = deadline ? ranked.filter((q) => q.lateDays === 0) : [];
  const best = deadline ? feasible[0] : ranked[0];
  const noOnTime = !!deadline && quoteRows.length > 0 && !feasible.length;
  const risks = supplierRisks(db, now).filter((r) => r.supplier.id === material.supplierId || quoteRows.some((q) => q.supplierId === r.supplier.id));
  const missingQuotes = requestedSuppliers.filter((s) => !quoteRows.some((q) => q.supplierId === s.id));
  const inTimeOrders = deadline ? material.orders.filter((o) => o.eta <= deadline.date) : [];
  const pending = [
    ...request.pending,
    ...(!request.quantity.unit ? [`本次数量未注明单位，暂按 ${material.unit} 比价，需确认计量单位`] : []),
    ...(!deadline ? ['请确认最晚到货日期；当前仅按金额比较，不能认定交期满足需求'] : []),
    `确认 ${quantity} ${material.unit} 是新增采购量还是生产总用量，并核对可分配库存及现有采购单，避免重复采购`,
    ...(best ? [...best.flags.filter((f) => f.includes('确认')), ...(best.excess > 0 ? [`${best.supplierName}的 MOQ 要求多采购 ${best.excess} ${material.unit}，需确认是否接受超量及额外资金占用`] : []), ...(best.supplierId !== material.supplierId ? [`${best.supplierName}并非现供，切换前需完成来料质量验证`] : [])] : []),
    ...missingQuotes.map((s) => `${s.name}已收录，但没有 ${material.code} 报价，需定向询价`),
    ...risks.filter((r) => r.conflictIds.length).map((r) => `${r.supplier.name}：${r.conflictIds.length} 条供应商归属字段不一致，待核实`),
  ];
  const stock = {
    title: '库存与在途核对',
    lines: [
      `当前库存 ${material.onHand} ${material.unit}，全部在途 ${material.inTransit} ${material.unit}，现有排产日耗 ${material.dailyUsage} ${material.unit}`,
      `现供：${supplierName(db, material.supplierId)}；库存按现有日耗与到货时间线可覆盖 ${material.cover.toFixed(1)} 天`,
      ...(deadline ? [`期限前预计到货 ${inTimeOrders.reduce((sum, o) => sum + o.qty, 0)} ${material.unit}（${inTimeOrders.map((o) => o.id).join('、') || '无在途单'}）`] : []),
      '上述库存与在途尚未核实可分配量，不直接当作本次需求的可用承诺。',
    ],
  };
  if (!quoteRows.length) {
    return {
      headline: `${material.code} 本次需求暂无可比报价，需先询价`, blocks: [summary, stock], pending,
      actions: [{ title: `${material.code} 按 ${quantity} ${material.unit}${deadline ? `、${deadline.date}前到货` : ''} 向合格供应商询价`, owner: '供应链经理', due }],
    };
  }
  const headline = noOnTime
    ? `${material.code} 暂无按期交付方案，需加急询价`
    : deadline ? `${material.code} 有 ${feasible.length} 家报价可覆盖期限，优先核实${best!.supplierName}`
    : `${material.code} 已按指定数量比价，到货日期待确认`;
  const conclusion = noOnTime
    ? [`现有 ${ranked.length} 家报价都无法在 ${deadline!.date} 前到货，不应按原交期下单。`, `最快的${ranked[0].supplierName}预计 ${ranked[0].eta} 到货，仍晚 ${ranked[0].lateDays} 天；需核实加急、替代现货或调整排产。`]
    : [
      `${best!.supplierName}：按 MOQ 需采购 ${best!.orderQty} ${material.unit}，比指定数量多 ${best!.excess} ${material.unit}，含税总额 ${best!.orderTotal.toFixed(2)} 元，预计 ${best!.eta} 到货。`,
      deadline ? '先筛选满足到货期限的报价，再按实际含税总额由低到高比较；交期仍需供应商确认。' : '当前按实际含税总额排序；需补充到货日期后才能判断是否按期。',
      best!.gapDays > 0 ? `现有排产在其到货前仍可能有约 ${Math.ceil(best!.gapDays)} 天缺口，需另行确认加急或排产。` : '其报价交期未超出现有库存覆盖天数。',
    ];
  return {
    headline,
    blocks: [summary, stock, { title: '本次比价结论', lines: conclusion },
      ...(requestedSuppliers.length ? [{ title: '指定供应商核对', lines: requestedSuppliers.map((s) => {
        const q = ranked.find((quote) => quote.supplierId === s.id);
        if (!q) return `${s.name}暂无 ${material.code} 报价，需按本次数量与期限定向询价。`;
        return `${s.name}：采购 ${q.orderQty} ${material.unit}，多采 ${q.excess} ${material.unit}，含税总额 ${q.orderTotal.toFixed(2)} 元，预计 ${q.eta} 到货；${deadline ? q.lateDays! > 0 ? `无法覆盖本次期限，晚 ${q.lateDays} 天` : '报价交期可覆盖本次期限，仍需确认' : '到货期限尚待确认'}；${q.paymentTerms}。`;
      }) }] : []), ...riskBlocks(risks)],
    facts: [`本次明确比价量 ${quantity} ${material.unit}`, ...(deadline ? [`最晚到货 ${deadline.date}，${feasible.length}/${ranked.length} 家报价可覆盖期限`] : []), ...ranked.map((q) => `${q.supplierName}：采购 ${q.orderQty} ${material.unit}，含税 ${q.orderTotal.toFixed(2)} 元，预计 ${q.eta} 到货`)],
    pending,
    suggestions: [noOnTime ? `优先向${ranked[0].supplierName}核实加急至 ${deadline!.date} 的可能性，同时寻找已验证的现货` : `核实${best!.supplierName}实际供货承诺、库存分配与付款条件后，由供应链经理决定是否提交采购审批`],
    actions: [
      { title: noOnTime ? `${material.code} 按 ${quantity} ${material.unit}、${deadline!.date}前到货加急询价并核实排产` : `${material.code} 确认 ${quantity} ${material.unit} 的需求口径、库存分配与${best!.supplierName}交期后再提交采购审批`, owner: '供应链经理', due: noOnTime ? today : (deadline?.days === 0 ? today : dateAfter(today, 1)) },
      ...missingQuotes.map((s) => ({ title: `向${s.name}询价 ${material.code} ${quantity} ${material.unit}${deadline ? `，要求 ${deadline.date} 前到货` : ''}`, owner: '供应链经理', due })),
    ],
    artifacts: [
      {
        kind: 'table', title: `${material.code} 比价表`,
        columns: ['排名', '供应商', '原始报价', '含税单价', 'MOQ', '采购量', '金额(万元)', '交期(天)', '准交率', '付款条件', '提示', '比需求多采', '预计到货', '是否按期'],
        rows: ranked.map((q, i) => [i + 1, q.supplierName, `${q.unitPrice.toFixed(2)}${q.taxIncluded ? '（含税）' : '（不含税）'}`, q.priceWithTax.toFixed(2), q.moq, q.orderQty, (q.orderTotal / 10000).toFixed(2), q.leadTimeDays, `${Math.round(q.onTimeRate * 100)}%`, q.paymentTerms, q.flags.join('；') || '—', q.excess, q.eta, deadline ? q.lateDays === 0 ? '报价交期可覆盖，待确认' : `晚 ${q.lateDays} 天` : '到货日期待确认']),
        note: `明确比价量 ${quantity} ${material.unit}；有期限时先比较是否按期，再按含税总额排序。单价展示保留两位，总额按未舍入的含税单价计算。报价交期按今天起算的自然日估算，需确认现货、排产与运输。${noOnTime ? '本次没有满足期限的报价，排名不代表可以按期采购。' : ''}`,
      },
      { kind: 'table', title: '本次采购需求', columns: ['物料', '指定比价量', '单位', '最晚到货', '期限前预计在途到货量'], rows: [[material.code, quantity, material.unit, deadline?.date ?? '待确认', deadline ? inTimeOrders.reduce((sum, o) => sum + o.qty, 0) : '待确认']] },
      riskTable(risks),
    ],
    events: riskEvents(risks),
  };
}
