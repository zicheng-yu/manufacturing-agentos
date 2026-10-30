import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate, keywordScore, round } from '../../core/util.ts';
import { coverDays, listMaterials, listQuotes, materialStatus, normalizeQuotes, supplierName, type Material } from './data.ts';

/** Quantity to bring cover back to safety stock plus one week. */
export function replenishQty(m: Material): number {
  const target = m.dailyUsage * (m.safetyDays + 7);
  return Math.max(0, Math.ceil((target - m.onHand - m.inTransit) / 100) * 100);
}

function pickMaterial(materials: Material[], input: string, withQuotes: Set<string>): Material {
  const scored = materials
    .map((m) => ({ m, score: (input.toUpperCase().includes(m.code) ? 100 : 0) + keywordScore(input, `${m.code} ${m.name} ${m.category}`) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0) {
    const best = scored.filter((s) => s.score === scored[0].score).map((s) => s.m);
    return best.find((m) => withQuotes.has(m.code)) ?? best[0];
  }
  return materials.filter((m) => withQuotes.has(m.code)).sort((a, b) => coverDays(a) - coverDays(b))[0] ?? materials[0];
}

export const sourcingAgent: AgentDefinition = {
  id: 'supply.sourcing',
  module: 'supply',
  name: '寻源比价助手',
  description: '多家报价按含税价、MOQ、交期、付款条件归一，结合库存缺口给出推荐',
  instructions: '你负责供应商寻源与比价。比较时必须使用已归一的含税单价与交期缺口，推荐要说明理由，付款条件等未确认事项放入 pending。',
  starters: ['FPC 有没有替代货源？帮我比一下价', '显示驱动 IC 的报价对比', '偏光片涨价后有什么应对'],
  context({ db, now, input }) {
    const materials = listMaterials(db);
    const quoted = new Set(
      (db.prepare('SELECT DISTINCT material_code FROM supply_quotes').all() as { material_code: string }[]).map((r) => r.material_code),
    );
    const material = pickMaterial(materials, input, quoted);
    const cover = coverDays(material);
    const quotes = listQuotes(db, material.code);
    const need = Math.max(replenishQty(material), material.dailyUsage * 3);
    const stock = [
      `${material.code} ${material.name}，${material.line}`,
      `库存 ${material.onHand} ${material.unit}，按期在途 ${material.inTransit}，日耗 ${material.dailyUsage}，可用 ${round(cover, 1)} 天（安全 ${material.safetyDays} 天），状态：${materialStatus(material)}`,
      `现供应商：${supplierName(db, material.supplierId)}`,
    ];
    if (quotes.length === 0) {
      return {
        headline: `${material.name} 暂无可比报价`,
        blocks: [{ title: '物料现状', lines: stock }],
        pending: [`${material.code} 需要先向至少 3 家合格供应商询价`],
        actions: [{ title: `${material.code} 发起询价`, owner: '供应链经理', due: isoDate(addDays(now, 2)) }],
      };
    }

    const ranked = normalizeQuotes(quotes, need, cover);
    const best = ranked[0];
    const lines = ranked.map(
      (q, i) =>
        `${i + 1}. ${q.supplierName}：含税 ${q.priceWithTax.toFixed(2)} 元，采购 ${q.orderQty}，金额 ${(q.orderTotal / 10000).toFixed(2)} 万元，交期 ${q.leadTimeDays} 天，准交率 ${Math.round(q.onTimeRate * 100)}%，${q.paymentTerms}${q.flags.length ? `（${q.flags.join('；')}）` : ''}`,
    );
    const prices = ranked.map((q) => q.priceWithTax);
    return {
      headline: `建议向${best.supplierName}采购 ${best.orderQty} ${material.unit} ${material.code}`,
      blocks: [
        { title: '物料现状', lines: stock },
        { title: `报价归一（需求 ${need} ${material.unit}）`, lines },
        {
          title: '推荐',
          lines: [
            `${best.supplierName}：综合含税价、交期缺口与准交率排名第一`,
            best.gapDays > 0 ? `到货前仍有约 ${Math.ceil(best.gapDays)} 天缺口，需要生产调整排产或加急` : '交期可覆盖当前库存缺口',
          ],
        },
      ],
      facts: [
        `${material.code} 当前可用 ${round(cover, 1)} 天，安全天数 ${material.safetyDays} 天`,
        `${ranked.length} 家报价归一后含税单价 ${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)} 元`,
      ],
      pending: best.flags.filter((f) => f.includes('确认')),
      suggestions: [`${material.code} 优先向${best.supplierName}下单 ${best.orderQty} ${material.unit}，现供应商在途订单保留`],
      actions: [
        { title: `向${best.supplierName}下达 ${material.code} 采购单 ${best.orderQty} ${material.unit}`, owner: '供应链经理', due: isoDate(addDays(now, 1)) },
      ],
      artifacts: [
        {
          kind: 'table',
          title: `${material.code} 比价表`,
          columns: ['排名', '供应商', '原始报价', '含税单价', 'MOQ', '采购量', '金额(万元)', '交期(天)', '准交率', '付款条件', '提示'],
          rows: ranked.map((q, i) => [
            i + 1,
            q.supplierName,
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
          note: '排序综合含税单价、到货前缺口天数与准交率；不含税报价按 13% 增值税换算',
        },
      ],
    };
  },
};

export const inventoryAgent: AgentDefinition = {
  id: 'supply.inventory',
  module: 'supply',
  name: '库存补货助手',
  description: '按库存、在途和日耗算可用天数，给出缺料预警与补货建议',
  instructions: '你负责库存与补货。可用天数和补货量以给出的计算结果为准，先说哪些物料有风险，再给补货建议。',
  starters: ['哪些物料快缺料了？', '本周需要补哪些货', '延迟在途单对产线有什么影响'],
  context({ db, now }) {
    const materials = listMaterials(db).sort((a, b) => coverDays(a) - coverDays(b));
    const risky = materials.filter((m) => materialStatus(m) !== '正常');
    const lines = materials.map(
      (m) => `${m.code} ${m.name}：可用 ${round(coverDays(m), 1)} 天 / 安全 ${m.safetyDays} 天 — ${materialStatus(m)}`,
    );
    return {
      headline: risky.length ? `${risky.length} 项物料低于安全库存，需补货` : '全部物料高于安全库存',
      blocks: [
        { title: '库存可用天数（由低到高）', lines },
        {
          title: '补货建议',
          lines: risky.length
            ? risky.map((m) => `${m.code} 建议补货 ${replenishQty(m)} ${m.unit}（${supplierName(db, m.supplierId)}）`)
            : ['暂无'],
        },
      ],
      facts: risky.map((m) => `${m.code} ${m.name} 可用 ${round(coverDays(m), 1)} 天，低于安全天数 ${m.safetyDays} 天`),
      actions: risky.map((m) => ({
        title: `${m.code} 补货 ${replenishQty(m)} ${m.unit}`,
        owner: '供应链经理',
        due: isoDate(addDays(now, materialStatus(m) === '缺料风险' ? 1 : 3)),
      })),
      artifacts: [
        {
          kind: 'table',
          title: '补货建议单',
          columns: ['料号', '物料', '产线', '可用天数', '安全天数', '状态', '建议补货量', '供应商'],
          rows: materials.map((m) => [
            m.code,
            m.name,
            m.line,
            round(coverDays(m), 1),
            m.safetyDays,
            materialStatus(m),
            replenishQty(m),
            supplierName(db, m.supplierId),
          ]),
        },
      ],
      events: risky
        .filter((m) => materialStatus(m) === '缺料风险')
        .map((m) => ({
          domain: 'supply' as const,
          type: 'stockout_risk',
          title: `${m.name} 缺料风险`,
          summary: `${m.line} ${m.name} 可用 ${round(coverDays(m), 1)} 天，低于安全天数 ${m.safetyDays} 天`,
          payload: { materialCode: m.code, materialName: m.name, line: m.line, coverDays: round(coverDays(m), 1) },
          source: { channel: 'agent' as const },
        })),
    };
  },
};
