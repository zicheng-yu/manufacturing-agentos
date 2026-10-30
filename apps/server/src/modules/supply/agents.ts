import type { AgentOSEvent } from '@agentos/shared';
import { listEvents } from '../../core/events.ts';
import type { AgentContext, AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate, round } from '../../core/util.ts';
import {
  listMaterials,
  listQuotes,
  listSuppliers,
  matchMaterial,
  materialStatus,
  normalizeQuotes,
  supplierName,
  type Material,
} from './data.ts';

/** Quantity to bring cover back to safety stock plus one week, counting everything already on order. */
export function replenishQty(m: Material): number {
  const target = m.dailyUsage * (m.safetyDays + 7);
  return Math.max(0, Math.ceil((target - m.onHand - m.inTransit) / 100) * 100);
}

/** The material a question is about; follow-ups without one reuse the last material mentioned. */
function resolveMaterial(materials: Material[], input: string, history: string[], prefer: Set<string>): Material | null {
  for (const text of [input, ...[...history].reverse()]) {
    const found = matchMaterial(materials, text, prefer);
    if (found) return found;
  }
  return null;
}

function orderLines(m: Material): string[] {
  return m.orders.map((o) => `${o.id}：${o.qty} ${m.unit}，预计 ${o.eta} 到货${o.delayDays ? `（已延迟 ${o.delayDays} 天）` : ''}，${o.status}`);
}

function stockLine(m: Material): string {
  return `库存 ${m.onHand} ${m.unit}，在途 ${m.inTransit}，日耗 ${m.dailyUsage}，可用 ${round(m.cover, 1)} 天（安全 ${m.safetyDays} 天）${m.stockoutDate && materialStatus(m) !== '正常' ? `，预计 ${m.stockoutDate} 断料` : ''}，状态：${materialStatus(m)}`;
}

/** Supply events about this material, and quality events naming its suppliers. */
function relatedEvents(events: AgentOSEvent[], m: Material, supplierNames: string[]): AgentOSEvent[] {
  return events.filter(
    (e) =>
      e.payload.materialCode === m.code ||
      (e.domain === 'quality' && typeof e.payload.supplier === 'string' && supplierNames.includes(e.payload.supplier)),
  );
}

function supplierOverview(ctx: Parameters<AgentDefinition['context']>[0]): AgentContext {
  const suppliers = listSuppliers(ctx.db).sort((a, b) => b.onTimeRate - a.onTimeRate);
  return {
    headline: '没有匹配到具体物料，以下是合格供应商概览',
    blocks: [
      {
        title: '合格供应商（按准交率排序）',
        lines: suppliers.map((s) => `${s.name}：${s.category}，${s.region}，评级 ${s.rating}，准交率 ${Math.round(s.onTimeRate * 100)}%，标准交期 ${s.leadTimeDays} 天${s.note ? `，${s.note}` : ''}`),
      },
      { title: '物料库', lines: [listMaterials(ctx.db, ctx.now).map((m) => `${m.code} ${m.name}`).join('；')] },
    ],
    pending: ['问题中的物料不在物料库中，如需比价请说明料号或物料名称'],
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
    '你负责供应商寻源与比价。比较时必须使用已归一的含税单价与交期缺口，推荐要说明理由；付款条件、新供应商质量验证等未确认事项放入 pending；系统不会替人下单，被要求下单时说明需由供应链经理审批执行。',
  starters: ['柔性板快断货了，几家供应商怎么选？', '驱动芯片找哪家买最划算？', '偏光片涨价后有什么应对'],
  context(ctx) {
    const { db, now, input, history, deps } = ctx;
    const materials = listMaterials(db, now);
    const quoted = new Set(
      (db.prepare('SELECT DISTINCT material_code FROM supply_quotes').all() as { material_code: string }[]).map((r) => r.material_code),
    );
    const material = resolveMaterial(materials, input, history, quoted);
    if (!material) return supplierOverview(ctx);

    const quotes = listQuotes(db, material.code);
    const current = supplierName(db, material.supplierId);
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
        blocks: [{ title: '物料现状', lines: stock }, eventBlock],
        facts: [stockLine(material)],
        pending: [`${material.code} 需要先向至少 3 家合格供应商询价`],
        actions: [{ title: `${material.code} 发起询价`, owner: '供应链经理', due: isoDate(addDays(now, 2)) }],
      };
    }

    const short = materialStatus(material) !== '正常';
    const need = short ? Math.max(replenishQty(material), material.dailyUsage * 3) : material.dailyUsage * 7;
    const ranked = normalizeQuotes(quotes, need, material.cover);
    const best = ranked[0];
    const prices = ranked.map((q) => q.priceWithTax);
    const lines = ranked.map(
      (q, i) =>
        `${i + 1}. ${q.supplierName}：含税 ${q.priceWithTax.toFixed(2)} 元，采购 ${q.orderQty}，金额 ${(q.orderTotal / 10000).toFixed(2)} 万元，交期 ${q.leadTimeDays} 天，准交率 ${Math.round(q.onTimeRate * 100)}%，${q.paymentTerms}${q.flags.length ? `（${q.flags.join('；')}）` : ''}`,
    );
    const newSupplier = best.supplierId !== material.supplierId;
    const recommend = short
      ? [
          `${best.supplierName}：综合含税价、交期缺口与准交率排名第一${newSupplier ? '（非现供应商）' : ''}`,
          best.gapDays > 0 ? `到货前仍有约 ${Math.ceil(best.gapDays)} 天缺口，需要生产调整排产或加急` : '交期可覆盖当前库存缺口',
        ]
      : [`库存可用 ${round(material.cover, 1)} 天，高于安全天数，暂不需要追加采购；比价按一周用量 ${need} ${material.unit} 作参考`];

    return {
      headline: short
        ? `建议向${best.supplierName}采购 ${best.orderQty} ${material.unit} ${material.code}`
        : `${material.code} 库存充足，暂不需要追加采购`,
      blocks: [
        { title: '物料现状', lines: stock },
        { title: `报价归一（${short ? '需求' : '参考量'} ${need} ${material.unit}）`, lines },
        { title: short ? '推荐' : '结论', lines: recommend },
        eventBlock,
      ],
      facts: [
        `${material.code} 可用 ${round(material.cover, 1)} 天，安全天数 ${material.safetyDays} 天`,
        `${ranked.length} 家报价归一后含税单价 ${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)} 元`,
        ...events.map((e) => `${e.typeLabel}：${e.title}`),
      ],
      pending: short
        ? [...best.flags.filter((f) => f.includes('确认')), ...(newSupplier ? [`${best.supplierName}为新供应商，需完成来料质量验证`] : [])]
        : [],
      suggestions: short
        ? [`${material.code} 优先向${best.supplierName}下单 ${best.orderQty} ${material.unit}，现有在途订单保留`]
        : [`${material.code} 维持现有采购节奏，跟踪价格变化`],
      actions: short
        ? [
            {
              title: `确认${best.supplierName}交期与付款条件后，下达 ${material.code} 采购单 ${best.orderQty} ${material.unit}`,
              owner: '供应链经理',
              due: isoDate(addDays(now, 1)),
            },
          ]
        : [],
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
  instructions: '你负责库存与补货。可用天数、断料日期和补货量以给出的计算结果为准，延迟订单按推迟后的到货日计入；先说哪些物料有风险，再给补货建议。',
  starters: ['哪些物料快缺料了？', '本周需要补哪些货', '延迟在途单对产线有什么影响'],
  context({ db, now }) {
    const materials = listMaterials(db, now).sort((a, b) => a.cover - b.cover);
    const risky = materials.filter((m) => materialStatus(m) !== '正常');
    const delayed = materials.flatMap((m) => m.orders.filter((o) => o.delayDays > 0).map((o) => ({ m, o })));
    return {
      headline: risky.length ? `${risky.length} 项物料低于安全库存，需补货` : '全部物料高于安全库存',
      blocks: [
        { title: '库存可用天数（由低到高）', lines: materials.map((m) => `${m.code} ${m.name}：${stockLine(m)}`) },
        {
          title: '延迟在途订单',
          lines: delayed.length
            ? delayed.map(({ m, o }) => `${o.id} ${m.code}（${supplierName(db, o.supplierId)}）：延迟 ${o.delayDays} 天，改为 ${o.eta} 到货；${m.code} 可用 ${round(m.cover, 1)} 天，${materialStatus(m)}`)
            : ['无'],
        },
        {
          title: '补货建议',
          lines: risky.length ? risky.map((m) => `${m.code} 建议补货 ${replenishQty(m)} ${m.unit}（${supplierName(db, m.supplierId)}）`) : ['暂无'],
        },
      ],
      facts: risky.map((m) => `${m.code} ${m.name} 可用 ${round(m.cover, 1)} 天，低于安全天数 ${m.safetyDays} 天${m.stockoutDate ? `，预计 ${m.stockoutDate} 断料` : ''}`),
      actions: risky.map((m) => ({
        title: `${m.code} 补货 ${replenishQty(m)} ${m.unit}`,
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
            round(m.cover, 1),
            m.safetyDays,
            materialStatus(m) === '正常' ? '—' : (m.stockoutDate ?? '—'),
            materialStatus(m),
            replenishQty(m),
            supplierName(db, m.supplierId),
          ]),
          note: '可用天数按到货时间线计算：每天扣日耗，订单在（延迟后的）到货日入库',
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
