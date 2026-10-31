import { matchMaterial, type Material, type Supplier } from './data.ts';
import { stripRequestTerms } from './request.ts';

const CITIES = /^(?:昆山|无锡|东莞|合肥|常州|上海|宁波|苏州)/;
const SUFFIXES = /(?:有限责任公司|有限公司|半导体|结构件|电子|柔电|电路|显示|科技|材料|箱业|机械|精密)$/;

function literalPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped + (value.startsWith('SUP-') ? '(?![A-Z0-9-])' : ''), 'gi');
}

function withoutSuppliers(suppliers: Supplier[], text: string): string {
  for (const supplier of suppliers) {
    for (const alias of supplierAliases(supplier).sort((a, b) => b.length - a.length)) {
      text = text.replaceAll(literalPattern(alias), ' ');
    }
  }
  return text;
}

/** Derive short names from the catalogue, rather than guessing a supplier from its category. */
export function supplierAliases(supplier: Supplier): string[] {
  const short = supplier.name.replace(CITIES, '');
  const brand = short.replace(SUFFIXES, '');
  return [...new Set([supplier.id, supplier.name, supplier.name.replace(SUFFIXES, ''), short, brand].filter((name) => name.length >= 2))];
}

export function matchSuppliers(suppliers: Supplier[], text: string): Supplier[] {
  const ids: string[] = text.toUpperCase().match(/SUP-[A-Z0-9-]+/g) ?? [];
  return suppliers.filter((s) => supplierAliases(s).some((alias) =>
    alias.startsWith('SUP-')
      ? ids.includes(alias)
      : text.toLowerCase().includes(alias.toLowerCase()),
  ));
}

export function unknownSuppliers(suppliers: Supplier[], text: string, materials: Material[]): string[] {
  if (isSupplierQuestion(suppliers, text)) return [];
  let remaining = withoutSuppliers(suppliers, text);
  for (const material of materials) {
    for (const alias of [material.code, material.name, ...material.aliases.split(/\s+/)].filter(Boolean).sort((a, b) => b.length - a.length)) {
      remaining = remaining.replaceAll(literalPattern(alias), ' ');
    }
  }
  const ids = remaining.toUpperCase().match(/SUP-[A-Z0-9-]+/g) ?? [];
  // Only explicit company-shaped names are treated as new suppliers. Generic questions stay generic.
  const names = remaining.match(/[\p{Script=Han}A-Za-z0-9]{2,24}?(?:有限公司|半导体|电子|柔电|电路|科技|材料|箱业)(?!板|片|胶)/gu) ?? [];
  const explicit = [...remaining.matchAll(/(?:供应商[：:\s]*|向|找|从|换成|换)([\p{Script=Han}A-Za-z0-9-]{2,24}?)(?=有没有|怎么样|行不行|是否|的|买|采购|询价|报价|供货|能|可|[，。！？\s]|$)/gu)]
    .map((match) => match[1])
    .filter((name) => !/^(?:哪|谁|什么|怎么|如何|其他|备选|更|风险|信息|资料|准交率|价格|报价|有没有|合适|可选|可用)/.test(name));
  return [...new Set([...ids, ...names.map((name) => name.replace(/^.*?(?:供应商|向|找|从|换成|换|比较|对比)/, '')), ...explicit])];
}

/** Only clear supplier-profile requests may omit a material. Unknown nouns must be clarified. */
export function isSupplierQuestion(suppliers: Supplier[], input: string): boolean {
  const remaining = withoutSuppliers(suppliers, input)
    .replace(/供应商|准交率|标准交期|交期|风险|资料|信息|情况|怎么样|如何|靠谱吗|靠谱么|可靠|行不行|是否|能力|介绍|概览|看看|查看|公司|有什么|有哪些|有哪几家|全部|所有|哪些|名单|列表|列出|多少|好吗|评价|有|的|这家|那家|是|吗|呢|请|帮我/gi, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  return remaining.length === 0;
}

export function materialCodes(text: string): string[] {
  return [...new Set(text.toUpperCase().match(/\b(?!SUP-)[A-Z]{1,8}-\d[A-Z0-9-]*\b/g) ?? [])];
}

/** An inventory overview must not swallow an unrecognised material name. */
export function isInventoryOverview(input: string): boolean {
  return input.replace(/在途订单|在途单|到货时间|安全库存|库存|缺料|断料|补货|物料|产线|采购|订单|在途|到货|延迟|风险|情况|概览|影响|最近|本周|今天|当前|全部|所有|哪些|列出|查看|看看|汇总|多少|有什么|怎么|如何|是否|需要|不足|足够|够用|能用|够|几|紧张|快|补|货|还|那|这|它|了|的|对|有|不|吗|呢|天|我|请|帮/gi, '')
    .replace(/[\s\p{P}\p{S}\d]/gu, '').length === 0;
}

export function isSupplierInventoryQuestion(suppliers: Supplier[], input: string): boolean {
  return isInventoryOverview(withoutSuppliers(suppliers, input).replace(/供应商|供货|供应|供的/g, ''));
}

export function resolveMaterial(materials: Material[], suppliers: Supplier[], input: string, history: string[], prefer: Set<string>): Material | null {
  for (const text of [input, ...[...history].reverse()]) {
    const subject = stripRequestTerms(withoutSuppliers(suppliers, text));
    // An explicit unknown SKU must never fall through to a category or an earlier question.
    const codes = materialCodes(text);
    if (codes.some((code) => !materials.some((m) => m.code === code))) return null;
    const current = matchMaterial(materials, subject, prefer);
    if (current) return current;
    // Stop at an unknown subject in history as well: later follow-ups cannot revive an older topic.
    const remainder = subject
      .replace(/更便宜|行不行|可不可以|怎么样|多少钱|供应商|付款条件|安全库存|补货|补|库存|缺料|断料|在途|加急|排产|到货|月结|预付|余款|账期|财务|确认|审批|采购|下单|交期|报价|价格|比价|划算|合适|风险|替代|推荐|选择|换成|换|那家|这家|上面|刚才|之前|为啥|为什么|多少|多久|能否|可以|需要|是否|够用|能用|够|几|MOQ|如何|怎么|还|再|那|这|它|要|的|呢|吗|了|好|选|天|元|万|我|请|帮/gi, '')
      .replace(/[\s\p{P}\p{S}\d]/gu, '');
    if (remainder) return null;
  }
  return null;
}
