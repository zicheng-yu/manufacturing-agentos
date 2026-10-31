import { createHash, randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return addMinutes(date, days * 24 * 60);
}

/** Wall-clock time in China (UTC+8) as "YYYY-MM-DD HH:MM", the format of the official pack's timestamps. */
export function chinaStamp(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 2026-10-30 */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function unique<T>(items: T[], key: (item: T) => string = String): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Score how many of the query's terms appear in the text. Terms are CJK bigrams plus latin words. */
export function keywordScore(query: string, text: string): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => (haystack.includes(term) ? score + term.length : score), 0);
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // Pure numbers ("30", "2") match codes like BLU-1230 by accident, so only words with a letter count.
  const latin = (lower.match(/[a-z0-9]{2,}/g) ?? []).filter((t) => /[a-z]/.test(t));
  const cjk: string[] = [];
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
  }
  return unique([...latin, ...cjk]);
}

/** Ignore whitespace and punctuation, so a rephrasing of a known item counts as a duplicate. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${round((numerator / denominator) * 100, 1)}%`;
}
