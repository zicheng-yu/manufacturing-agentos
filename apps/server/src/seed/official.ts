// Reader for the track's official material pack, converted by scripts/convert-official-pack.py into data/official/.
// The tables are simulated business data with deliberate noise, gaps and spikes, so every number goes through num().
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../../../data/official/', import.meta.url));

export type OfficialRow = Record<string, string>;

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

const cache = new Map<string, OfficialRow[]>();

/** Rows of one official table, keyed by its Chinese column headers. */
export function officialTable(name: string): OfficialRow[] {
  const cached = cache.get(name);
  if (cached) return cached;
  const [header, ...body] = parseCsv(readFileSync(`${DIR}tables/${name}.csv`, 'utf8'));
  const rows = body.map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()])));
  cache.set(name, rows);
  return rows;
}

/** A number, or null for blanks and non-numeric noise such as "N/A". */
export function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export interface PolicySection {
  id: string;
  module: 'hr' | 'supply' | 'quality' | 'logistics';
  document: string;
  code: string;
  version: string;
  effectiveFrom: string | null;
  chapter: string;
  section: string;
  title: string;
  text: string;
}

/** The four regulations, split into numbered sections. */
export function officialPolicies(): PolicySection[] {
  return JSON.parse(readFileSync(`${DIR}policies.json`, 'utf8')) as PolicySection[];
}

/** One clause by id, e.g. "SCM-2025-001-5.2", for citing a rule an analysis applies. */
export function policyClause(id: string): PolicySection | undefined {
  return officialPolicies().find((p) => p.id === id);
}

/** "《工厂供应链管理制度》5.2 供应商绩效评分卡" */
export function cite(id: string): string {
  const p = policyClause(id);
  return p ? `《${p.document}》${p.section} ${p.title}` : id;
}
