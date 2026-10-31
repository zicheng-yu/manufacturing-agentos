import type { AgentOSEvent } from '@agentos/shared';
import { listEvents } from '../../core/events.ts';
import type { AgentContext, AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate, round } from '../../core/util.ts';
import {
  listMaterials,
  listQuotes,
  listSuppliers,
  matchesDimensions,
  materialStatus,
  normalizeQuotes,
  supplierName,
  type Material,
  coverText,
  stockRatio,
} from './data.ts';
import { isInventoryOverview, isSupplierInventoryQuestion, isSupplierQuestion, matchSuppliers, materialCodes, resolveMaterial, unknownSuppliers } from './lookup.ts';
import { riskBlocks, riskEvents, riskTable, supplierRisks } from './risk.ts';
import { inheritPurchaseRequest } from './request.ts';
import { purchaseContext } from './purchase.ts';

/** Quantity to bring cover back to safety stock plus one week, counting everything already on order. */
export function replenishQty(m: Material): number {
  // Without a usage rate the only defensible target is the safety stock itself.
  if (m.dailyUsage <= 0) return Math.max(0, Math.ceil((m.safetyStock - m.onHand - m.inTransit) / 100) * 100);
  const target = m.dailyUsage * (m.safetyDays + 7);
  return Math.max(0, Math.ceil((target - m.onHand - m.inTransit) / 100) * 100);
}

function orderLines(m: Material): string[] {
  return m.orders.map((o) => `${o.id}：${o.qty} ${m.unit}，预计 ${o.eta} 到货${o.delayDays ? `（已延迟 ${o.delayDays} 天）` : ''}，${o.status}`);
}

function stockLine(m: Material): string {
  return `库存 ${m.onHand} ${m.unit}，在途 ${m.inTransit}，${m.dailyUsage > 0 ? `日耗 ${m.dailyUsage}，` : ''}${coverText(m)}，状态：${materialStatus(m)}`;
}

/** Supply events about this material, and quality events naming its suppliers. */
function relatedEvents(events: AgentOSEvent[], m: Material, supplierNames: string[]): AgentOSEvent[] {
  return events.filter(
    (e) =>
      e.payload.materialCode === m.code ||
      (e.domain === 'quality' && typeof e.payload.supplier === 'string' && supplierNames.includes(e.payload.supplier)),
  );
}

function supplierOverview(ctx: Parameters<AgentDefinition['context']>[0], unknown: string[] = []): AgentContext {
  const suppliers = listSuppliers(ctx.db).sort((a, b) => b.onTimeRate - a.onTimeRate);
  const subject = unknown.length ? unknown.join('、') : ctx.input;
  const missing = `未收录或未匹配到「${subject}」，无法确认其报价、库存或资质`;
  return {
    headline: missing,
    blocks: [
      {
        title: '合格供应商（按准交率排序）',
        lines: suppliers.map((s) => `${s.name}：${s.category}，${s.region}，评级 ${s.rating}，准交率 ${Math.round(s.onTimeRate * 100)}%，标准交期 ${s.leadTimeDays} 天${s.note ? `，${s.note}` : ''}`),
      },
      { title: '物料库', lines: [listMaterials(ctx.db, ctx.now).map((m) => `${m.code} ${m.name}`).join('；')] },
    ],
    pending: [missing, '请补充准确料号、物料规格或供应商全称，确认收录后再比价'],
    actions: [{ title: `核实「${subject}」的物料规格或供应商资质并发起询价`, owner: '供应链经理', due: isoDate(addDays(ctx.now, 2)) }],
    artifacts: [
      {
        kind: 'table',
        title: '合格供应商',
        columns: ['供应商', '品类', '区域', '评级', '准交率', '标准交期(天)'],
        rows: suppliers.map((s) => [s.name, s.category, s.region, s.rating, `${Math.round(s.onTimeRate * 100)}%`, s.leadTimeDays]),
      },
    ],
  };
}

export const sourcingAgent: AgentDefinition = {
  id: 'supply.sourcing',
  module: 'supply',
  name: '寻源比价助手',
  description: '多家报价按含税价、MOQ、交期、付款条件归一，结合库存缺口给出推荐',
  instructions:
    '你负责供应商寻源与比价。比较时必须使用已归一的含税单价与交期缺口，推荐要说明理由；用户给出本次数量和期限时以本次采购需求为准，不得改用默认补货量。无按期方案时明确说明，不能把排名第一说成满足期限。付款条件、库存分配、新供应商质量验证等未确认事项放入 pending；系统不会替人下单，被要求下单时说明需由供应链经理审批执行。',
  starters: ['柔性板快断货了，几家供应商怎么选？', '驱动芯片找哪家买最划算？', '偏光片涨价后有什么应对'],
  startersByDataset: { official: ['线束快断货了，几家供应商怎么选？', 'M-10003 找哪家买最划算？', '线束03 采购要走什么审批？'] },
  context(ctx) {
    const { db, now, input, history, deps } = ctx;
    const materials = listMaterials(db, now);
    const suppliers = listSuppliers(db);
    const unknown = unknownSuppliers(suppliers, input, materials);
    if (unknown.length) return supplierOverview(ctx, unknown);
    const requested = matchSuppliers(suppliers, input);
    const quoted = new Set(
      (db.prepare('SELECT DISTINCT material_code FROM supply_quotes').all() as { material_code: string }[]).map((r) => r.material_code),
    );
    const material = resolveMaterial(materials, suppliers, input, history, quoted);
    const risks = supplierRisks(db, now);
    const selectedRisks = requested.length ? risks.filter((r) => requested.some((s) => s.id === r.supplier.id)) : risks;
    // A supplier-only question gets that supplier's own evidence, with no guessed material.
    if ((requested.length || input.includes('供应商')) && isSupplierQuestion(suppliers, input)) {
      return {
        headline: requested.length ? `${requested.map((s) => s.name).join('、')}：供应商资料与风险` : '供应商风险概览',
        blocks: [{ title: '供应商资料', lines: selectedRisks.map((r) => `${r.supplier.name}：${r.supplier.category}，${r.supplier.region}，标准交期 ${r.supplier.leadTimeDays} 天`) }, ...riskBlocks(selectedRisks)],
        facts: selectedRisks.map((r) => `${r.supplier.name}：准交率 ${Math.round(r.supplier.onTimeRate * 100)}%，近30天 ${r.delays} 单延迟、${r.qualityCases} 起关联品质案例`),
        pending: ['风险分是演示规则评分，品质案例关联需核实；如需比价请补充料号', ...selectedRisks.filter((r) => r.conflictIds.length).map((r) => `${r.supplier.name}：${r.conflictIds.length} 条事件的供应商归属字段不一致，需核实`)],
        actions: selectedRisks.filter((r) => r.score >= 30).map((r) => ({ title: `核实${r.supplier.name}交付承诺与品质关联，确认备选货源`, owner: '供应链经理', due: isoDate(addDays(now, 1)) })),
        artifacts: [riskTable(selectedRisks)],
        events: riskEvents(selectedRisks),
      };
    }
    if (!material) return supplierOverview(ctx);

    const scopedHistory: string[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const previous = resolveMaterial(materials, suppliers, '那怎么选', history.slice(0, i + 1), quoted);
      if (!previous || previous.code !== material.code) break;
      scopedHistory.unshift(history[i]);
    }
    const request = inheritPurchaseRequest(input, scopedHistory, now);
    if (request.quantitySpecified || request.deadlineSpecified || request.errors.length) return purchaseContext(ctx, material, request, requested);

    const quotes = listQuotes(db, material.code);
    const current = supplierName(db, material.supplierId);
    const relevantRisks = risks.filter((r) => r.supplier.id === material.supplierId || quotes.some((q) => q.supplierId === r.supplier.id));
    const missingQuotes = requested.filter((s) => !quotes.some((q) => q.supplierId === s.id));
    const events = relatedEvents(
      listEvents(deps, { domains: ['supply', 'quality'], status: 'unresolved', limit: 100 }),
      material,
      [current, ...quotes.map((q) => q.supplierName)],
    );
    const eventBlock = { title: '相关事件', lines: events.length ? events.map((e) => `${e.typeLabel}：${e.title}。${e.summary}`) : ['无'] };
    const stock = [`${material.code} ${material.name}，${material.line}`, stockLine(material), `现供应商：${current}`, ...orderLines(material)];

    if (quotes.length === 0) {
      return {
        headline: `${material.name} 暂无可比报价`,
        blocks: [{ title: '物料现状', lines: stock }, eventBlock, ...riskBlocks(relevantRisks)],
        facts: [stockLine(material)],
        pending: [`${material.code} 需要先向至少 3 家合格供应商询价`],
        actions: [{ title: `${material.code} 发起询价`, owner: '供应链经理', due: isoDate(addDays(now, 2)) }],
        artifacts: [riskTable(relevantRisks)],
        events: riskEvents(relevantRisks),
      };
    }

    const short = materialStatus(material) !== '正常';
    const expediteOnly = short && replenishQty(material) === 0;
    const need = short ? Math.max(replenishQty(material), material.dailyUsage * 3) : material.dailyUsage * 7;
    const ranked = normalizeQuotes(quotes, need, material.cover);
    const best = ranked[0];
    const prices = ranked.map((q) => q.priceWithTax);
    const lines = ranked.map(
      (q, i) =>
        `${i + 1}. ${q.supplierName}：含税 ${q.priceWithTax.toFixed(2)} 元，采购 ${q.orderQty}，金额 ${(q.orderTotal / 10000).toFixed(2)} 万元，交期 ${q.leadTimeDays} 天，准交率 ${Math.round(q.onTimeRate * 100)}%，${q.paymentTerms}${q.flags.length ? `（${q.flags.join('；')}）` : ''}`,
    );
    const newSupplier = best.supplierId !== material.supplierId;
    const recommend = expediteOnly
      ? ['库存与在途总量已覆盖目标需求，但到货前仍存在缺口；优先加急现有订单并核实排产，无需重复追加采购', '以下比价仅为应急备选，切换供应商前需核对现有采购单的加急、取消或改量方案']
      : short
      ? [
          `${best.supplierName}：综合含税价、交期缺口与准交率排名第一${newSupplier ? '（非现供应商）' : ''}`,
          best.gapDays > 0 ? `到货前仍有约 ${Math.ceil(best.gapDays)} 天缺口，需要生产调整排产或加急` : '交期可覆盖当前库存缺口',
        ]
      : [`库存可用 ${round(material.cover, 1)} 天，高于安全天数，暂不需要追加采购；比价按一周用量 ${need} ${material.unit} 作参考`];

    return {
      headline: expediteOnly
        ? `${material.code} 优先加急现有在途订单，避免重复采购`
        : short
        ? `建议向${best.supplierName}采购 ${best.orderQty} ${material.unit} ${material.code}`
        : `${material.code} 库存充足，暂不需要追加采购`,
      blocks: [
        { title: '物料现状', lines: stock },
        { title: `报价归一（${short && !expediteOnly ? '需求' : '参考量'} ${need} ${material.unit}）`, lines },
        { title: short ? '推荐' : '结论', lines: recommend },
        ...(requested.length ? [{ title: '指定供应商核对', lines: requested.map((s) => {
          const q = ranked.find((quote) => quote.supplierId === s.id);
          return q ? `${s.name}：含税 ${q.priceWithTax.toFixed(2)} 元，采购量 ${q.orderQty}，到货前缺口 ${round(q.gapDays, 1)} 天；${q.flags.join('；') || '无额外提示'}。切换前仍需确认交期与品质验证。` : `${s.name}已收录，但暂无 ${material.code} 报价，不能据其他物料价格推断，需先询价`;
        }) }] : []),
        eventBlock,
        ...riskBlocks(relevantRisks),
      ],
      facts: [
        `${material.code} 可用 ${round(material.cover, 1)} 天，安全天数 ${material.safetyDays} 天`,
        `${ranked.length} 家报价归一后含税单价 ${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)} 元`,
        ...events.map((e) => `${e.typeLabel}：${e.title}`),
      ],
      pending: [...missingQuotes.map((s) => `${s.name}暂无 ${material.code} 报价，需询价`), ...relevantRisks.filter((r) => r.conflictIds.length).map((r) => `${r.supplier.name}：${r.conflictIds.length} 条事件的供应商归属字段不一致，需核实`), ...(short
        ? [...best.flags.filter((f) => f.includes('确认')), ...(newSupplier ? [`${best.supplierName}为新供应商，需完成来料质量验证`] : [])]
        : [])],
      suggestions: expediteOnly
        ? [`${material.code} 先核实在途到货能否提前，并调整缺口期间的排产；替代货源作为应急备选`]
        : short
        ? [`${material.code} 优先向${best.supplierName}下单 ${best.orderQty} ${material.unit}，现有在途订单保留`]
        : [`${material.code} 维持现有采购节奏，跟踪价格变化`],
      actions: [...missingQuotes.map((s) => ({ title: `向${s.name}询价 ${material.code} 并核实供货资质`, owner: '供应链经理', due: isoDate(addDays(now, 2)) })), ...(expediteOnly
        ? [{ title: `${material.code} 加急现有在途订单并核实排产，避免重复采购`, owner: '供应链经理', due: isoDate(addDays(now, 1)) }]
        : short
        ? [
            {
              title: `确认${best.supplierName}交期与付款条件后，下达 ${material.code} 采购单 ${best.orderQty} ${material.unit}`,
              owner: '供应链经理',
              due: isoDate(addDays(now, 1)),
            },
          ]
        : [])],
      events: riskEvents(relevantRisks),
      artifacts: [
        {
          kind: 'table',
          title: `${material.code} 比价表`,
          columns: ['排名', '供应商', '原始报价', '含税单价', 'MOQ', '采购量', '金额(万元)', '交期(天)', '准交率', '付款条件', '提示'],
          rows: ranked.map((q, i) => [
            i + 1,
            q.supplierId === material.supplierId ? `${q.supplierName}（现供）` : q.supplierName,
            `${q.unitPrice.toFixed(2)}${q.taxIncluded ? '（含税）' : '（不含税）'}`,
            q.priceWithTax.toFixed(2),
            q.moq,
            q.orderQty,
            (q.orderTotal / 10000).toFixed(2),
            q.leadTimeDays,
            `${Math.round(q.onTimeRate * 100)}%`,
            q.paymentTerms,
            q.flags.join('；') || '—',
          ]),
          note: `排序综合含税单价、到货前缺口天数与准交率；不含税报价按 13% 增值税换算${expediteOnly ? '。本次采购量仅为应急备选比价参考，不代表追加采购建议' : ''}`,
        },
        riskTable(relevantRisks),
      ],
    };
  },
};

export const inventoryAgent: AgentDefinition = {
  id: 'supply.inventory',
  module: 'supply',
  name: '库存补货助手',
  description: '按库存、在途和日耗算可用天数，给出缺料预警与补货建议',
  instructions: '你负责库存与补货。可用天数、断料日期和补货量以给出的计算结果为准，延迟订单按推迟后的到货日计入；先说哪些物料有风险，再给补货建议。',
  starters: ['哪些物料快缺料了？', '本周需要补哪些货', '延迟在途单对产线有什么影响'],
  startersByDataset: { official: ['哪些物料快缺料了？', '本周需要补哪些货', '线束03 安全库存够不够？'] },
  context(ctx) {
    const { db, now, input, history } = ctx;
    const all = listMaterials(db, now);
    const suppliers = listSuppliers(db);
    const unknown = unknownSuppliers(suppliers, input, all);
    if (unknown.length) return supplierOverview(ctx, unknown);
    const codes = materialCodes(input);
    if (codes.some((code) => !all.some((m) => m.code === code && matchesDimensions(m, input)))) return supplierOverview(ctx);
    const requested = matchSuppliers(suppliers, input);
    const direct = resolveMaterial(all, suppliers, input, [], new Set());
    const overview = isInventoryOverview(input);
    const followUp = !requested.length && !/全部|所有|哪些|概览|汇总/.test(input) && /那|这|它|呢|还/.test(input)
      ? resolveMaterial(all, suppliers, input, history, new Set()) : null;
    const selected = codes.length ? all.filter((m) => codes.includes(m.code)) : direct ? [direct] : followUp ? [followUp] : null;
    // A supplier-only stock query applies to its current supplied materials, never an arbitrary SKU.
    const supplierStock = requested.length && isSupplierInventoryQuestion(suppliers, input);
    if (!selected && !overview && !supplierStock) return supplierOverview(ctx);
    const materials = (selected ?? (requested.length ? all.filter((m) => requested.some((s) => s.id === m.supplierId)) : all))
      .sort((a, b) => stockRatio(a) - stockRatio(b));
    if (!materials.length) {
      return {
        headline: `${requested.map((s) => s.name).join('、')}已收录，但没有关联的现供物料库存`,
        blocks: [], pending: ['请补充准确料号；供应商有报价不等于已成为该物料的现供'],
        actions: [{ title: `核实${requested.map((s) => s.name).join('、')}的供货物料并询价`, owner: '供应链经理', due: isoDate(addDays(now, 2)) }],
      };
    }
    const risky = materials.filter((m) => materialStatus(m) !== '正常');
    const delayed = materials.flatMap((m) => m.orders.filter((o) => o.delayDays > 0).map((o) => ({ m, o })));
    return {
      headline: risky.length ? `本次查询 ${risky.length} 项物料低于安全库存，需补货或加急` : `本次查询 ${materials.length} 项物料均高于安全库存`,
      blocks: [
        { title: '库存（按距安全库存由近到远）', lines: materials.map((m) => `${m.code} ${m.name}：${stockLine(m)}`) },
        {
          title: '延迟在途订单',
          lines: delayed.length
            ? delayed.map(({ m, o }) => `${o.id} ${m.code}（${supplierName(db, o.supplierId)}）：延迟 ${o.delayDays} 天，改为 ${o.eta} 到货；${m.code} 可用 ${round(m.cover, 1)} 天，${materialStatus(m)}`)
            : ['无'],
        },
        {
          title: '补货建议',
          lines: risky.length ? risky.map((m) => replenishQty(m) > 0
            ? `${m.code} 建议补货 ${replenishQty(m)} ${m.unit}（${supplierName(db, m.supplierId)}），并核实交期能否覆盖缺口`
            : `${m.code} 库存与在途总量已覆盖目标需求，但到货前仍存在缺口；优先加急现有订单并核实排产，无需重复追加采购`) : ['暂无'],
        },
      ],
      facts: risky.map((m) => `${m.code} ${m.name} 库存 ${m.onHand} ${m.unit}，${coverText(m)}`),
      actions: risky.map((m) => ({
        title: replenishQty(m) > 0 ? `${m.code} 补货 ${replenishQty(m)} ${m.unit}，确认交期覆盖缺口` : `${m.code} 加急现有在途订单并核实排产，避免重复采购`,
        owner: '供应链经理',
        due: isoDate(addDays(now, materialStatus(m) === '缺料风险' ? 1 : 3)),
      })),
      artifacts: [
        {
          kind: 'table',
          title: '补货建议单',
          columns: ['料号', '物料', '产线', '可用天数', '安全天数', '预计断料', '状态', '建议补货量', '供应商'],
          rows: materials.map((m) => [
            m.code,
            m.name,
            m.line,
            m.dailyUsage > 0 ? round(m.cover, 1) : '—',
            m.dailyUsage > 0 ? m.safetyDays : `${m.safetyStock} ${m.unit}（数量）`,
            materialStatus(m) === '正常' ? '—' : (m.stockoutDate ?? '—'),
            materialStatus(m),
            materialStatus(m) === '正常' ? 0 : replenishQty(m),
            supplierName(db, m.supplierId),
          ]),
          note: '可用天数按到货时间线计算：每天扣日耗，订单在（延迟后的）到货日入库。建议补货量只在低于安全库存时计算；数量为0但仍有缺口时，应加急现有订单并核实排产。',
        },
      ],
      events: risky
        .filter((m) => materialStatus(m) === '缺料风险')
        .map((m) => ({
          domain: 'supply' as const,
          type: 'stockout_risk',
          title: `${m.name} 缺料风险`,
          summary: `${m.line} ${m.name} 可用 ${round(m.cover, 1)} 天，低于安全天数 ${m.safetyDays} 天`,
          payload: { materialCode: m.code, materialName: m.name, line: m.line, coverDays: round(m.cover, 1) },
          source: { channel: 'agent' as const },
        })),
    };
  },
};
