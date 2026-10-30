const NUMBER = '(?:-?\\d[\\d,]*(?:\\.\\d+)?[万千]?|[零〇一二两三四五六七八九十百千万]+)';
const QUANTITY = new RegExp(`(?<![A-Za-z0-9-])(${NUMBER})\\s*(片|颗|套|件|个|箱|张)`, 'g');
const QUANTITY_CUE = new RegExp(`(?:数量|采购量|需求量|采购|购买|买)\\s*(?:改为|改成|调整为|为|是|[:：])?\\s*(${NUMBER})(?![\\d零一二两三四五六七八九十百千万.%元年月日天批种次家])`, 'g');
const ABSOLUTE_DATE = /(?<![A-Za-z0-9-])(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?/g;
const RELATIVE_DAYS = new RegExp(`(${NUMBER})\\s*(?:个)?(?:自然)?天\\s*(?:之内|以内|内|后|能到货|能到|到货|到)`, 'g');
const LEAD_DAYS = new RegExp(`(?:交期|到货期限)\\s*(?:放宽到|缩短到|改为|改成|不超过|最多|为|是|[:：])?\\s*(${NUMBER})\\s*天`, 'g');
const DAY_WORD = /(今天|明天|后天)(?=必须|需要|一定|就|前|要|到货|到|交货|用)|(?:最晚|必须在)(今天|明天|后天)/g;
const DAY_MS = 86_400_000;

export interface PurchaseRequest {
  quantity?: { value: number; unit?: string };
  deadline?: { date: string; days: number; relative: boolean };
  quantitySpecified: boolean;
  deadlineSpecified: boolean;
  errors: string[];
  pending: string[];
}

export function localDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function dateAfter(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function numberValue(raw: string): number {
  const value = raw.replaceAll(',', '');
  if (/^-?\d/.test(value)) return Number(value.replace(/[万千]$/, '')) * (value.endsWith('万') ? 10000 : value.endsWith('千') ? 1000 : 1);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of value) {
    if (char in digits) digit = digits[char];
    else if (char === '万') { total += (section + digit || 1) * 10000; section = 0; digit = 0; }
    else { section += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char] ?? 0); digit = 0; }
  }
  return total + section + digit;
}

function paymentClause(text: string, index: number): boolean {
  const before = text.slice(0, index).split(/[，。！？；,;\n]/).at(-1) ?? '';
  const after = text.slice(index).split(/[，。！？；,;\n]/)[0];
  const clause = before + after;
  return /付款|账期|月结|支付|结算/.test(clause) && !/到货|交货|交期|送达|必须到/.test(clause);
}

function quantityValue(raw: string, errors: string[]): number {
  if (raw.includes(',') && !/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?[万千]?$/.test(raw)) errors.push('采购数量的千位分隔不规范，请核实数字');
  if (/[一二两三四五六七八九]{2}|[千百][一二两三四五六七八九]$/.test(raw)) errors.push('采购数量的中文写法可能有歧义，请使用完整数量或阿拉伯数字');
  return numberValue(raw);
}

function choose<T>(values: { value: T; key: string; index: number }[], input: string, label: string, errors: string[]): T | undefined {
  const unique = new Set(values.map((v) => v.key));
  if (!values.length) return undefined;
  if (unique.size > 1 && !/改为|改成|调整为|变更为|改到/.test(input.slice(values[0].index, values.at(-1)!.index))) {
    errors.push(`${label}有多个不同值，请明确本次采用哪一个`);
    return undefined;
  }
  return values.at(-1)!.value;
}

/** Bounded, deterministic extraction. Unsupported or contradictory constraints are surfaced, never guessed. */
export function parsePurchaseRequest(input: string, now: Date): PurchaseRequest {
  const request: PurchaseRequest = { quantitySpecified: false, deadlineSpecified: false, errors: [], pending: [] };
  const quantities: { value: { value: number; unit?: string }; key: string; index: number }[] = [];
  const primary = [...input.matchAll(QUANTITY)].filter((m) => !/MOQ\s*[:：]?\s*$/i.test(input.slice(Math.max(0, m.index! - 12), m.index)));
  for (const m of primary) {
    const value = quantityValue(m[1], request.errors);
    quantities.push({ value: { value, unit: m[2] }, key: `${value}:${m[2]}`, index: m.index! });
  }
  for (const m of input.matchAll(QUANTITY_CUE)) {
    if (!primary.some((p) => m.index! <= p.index! && p.index! < m.index! + m[0].length)) {
      const value = quantityValue(m[1], request.errors);
      quantities.push({ value: { value }, key: String(value), index: m.index! });
    }
  }
  quantities.sort((a, b) => a.index - b.index);
  request.quantitySpecified = quantities.length > 0;
  request.quantity = choose(quantities, input, '采购数量', request.errors);
  if (new RegExp(`(${NUMBER})\\s*(?:到|至|~|～|—|-)\\s*(${NUMBER})\\s*(?:片|颗|套|件|个|箱|张)`).test(input)) {
    request.quantitySpecified = true;
    request.errors.push('采购数量是一个范围，请明确本次用于比价的单一数量');
  }
  if (request.quantity && new RegExp(`(?:再加|增加|追加|加购|减少|减去|减掉)\\s*(${NUMBER})`).test(input)) {
    request.errors.push('请明确调整后的总采购数量，追加或减少的数量不能直接当作本次总量');
  }
  if (request.quantity && (!Number.isSafeInteger(request.quantity.value) || request.quantity.value <= 0 || request.quantity.value > 1e9)) {
    request.errors.push('采购数量需为大于0且不超过10亿的整数');
    request.quantity = undefined;
  }

  const today = localDate(now);
  const deadlines: { value: NonNullable<PurchaseRequest['deadline']>; key: string; index: number }[] = [];
  for (const m of input.matchAll(ABSOLUTE_DATE)) {
    if (paymentClause(input, m.index!)) continue;
    request.deadlineSpecified = true;
    const date = `${m[1] ?? today.slice(0, 4)}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) { request.errors.push('到货日期不存在，请核实年月日'); continue; }
    deadlines.push({ value: { date, days: (parsed.getTime() - Date.parse(`${today}T00:00:00Z`)) / DAY_MS, relative: false }, key: date, index: m.index! });
  }
  for (const pattern of [RELATIVE_DAYS, LEAD_DAYS]) {
    for (const m of input.matchAll(pattern)) {
      if (paymentClause(input, m.index!)) continue;
      request.deadlineSpecified = true;
      const days = numberValue(m[1]);
      if (!Number.isInteger(days) || days < 0 || days > 365) { request.errors.push('到货期限需为0至365个自然日，或提供具体日期'); continue; }
      const date = dateAfter(today, days);
      deadlines.push({ value: { date, days, relative: true }, key: date, index: m.index! });
    }
  }
  for (const m of input.matchAll(DAY_WORD)) {
    if (paymentClause(input, m.index!)) continue;
    const days = { 今天: 0, 明天: 1, 后天: 2 }[(m[1] ?? m[2]) as '今天' | '明天' | '后天'];
    const date = dateAfter(today, days);
    request.deadlineSpecified = true;
    deadlines.push({ value: { date, days, relative: true }, key: date, index: m.index! });
  }
  if (/工作日|(?:下|本)?周[一二三四五六日天]/.test(input)) {
    request.deadlineSpecified = true;
    request.errors.push('请提供具体到货日期；工作日或周几尚不能直接换算为自然日交期');
  }
  deadlines.sort((a, b) => a.index - b.index);
  request.deadline = choose(deadlines, input, '到货期限', request.errors);
  if (request.deadline && (request.deadline.days < 0 || request.deadline.days > 365)) {
    request.errors.push('到货日期已过或超过一年，请确认本次期限');
    request.deadline = undefined;
  }
  return request;
}

export function inheritPurchaseRequest(input: string, history: string[], now: Date): PurchaseRequest {
  const request = parsePurchaseRequest(input, now);
  for (const previous of [...history].reverse()) {
    const older = parsePurchaseRequest(previous, now);
    if (!request.quantitySpecified && older.quantitySpecified) {
      request.quantity = older.quantity;
      request.quantitySpecified = true;
      request.errors.push(...older.errors.filter((e) => e.includes('数量')));
    }
    if (!request.deadlineSpecified && older.deadlineSpecified) {
      request.deadlineSpecified = true;
      if (older.deadline && !older.deadline.relative) request.deadline = older.deadline;
      else request.pending.push('请确认本次最晚到货日期（上一轮使用了相对期限），以免追问时误延长交期');
    }
    if (request.quantitySpecified && request.deadlineSpecified) break;
  }
  return request;
}

/** Strip only request syntax so quantity/date-only follow-ups can resolve their material. */
export function stripRequestTerms(input: string): string {
  let stripped = input;
  for (const pattern of [QUANTITY, QUANTITY_CUE, ABSOLUTE_DATE, RELATIVE_DAYS, LEAD_DAYS, DAY_WORD]) stripped = stripped.replace(pattern, ' ');
  stripped = stripped.replace(/(?:下|本)?周[一二三四五六日天]/g, ' ').replace(new RegExp(`(${NUMBER})\\s*(?:个)?工作日(?:内|后)?`, 'g'), ' ');
  return stripped.replace(/放宽到|缩短到|改成|改为|调整为|变更为|改到|数量|最晚|必须|一定|之内|以内|到货期限|到货日期|期限|自然日|只要|现在|到货|送达|交货|购买|订购|就买|买|到/g, ' ');
}
