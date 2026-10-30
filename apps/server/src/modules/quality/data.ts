import type { DB, Row } from '../../db.ts';
import { keywordScore } from '../../core/util.ts';
import { shiftDate, validDate } from './calendar.ts';
import { GENERIC_SYMPTOMS, normalizeSymptom } from './symptoms.ts';

export interface QualityCase {
  id: string;
  title: string;
  /** Plain words people use for the symptom, e.g. 起泡 for 偏光片气泡. */
  keywords: string;
  product: string;
  category: string;
  symptom: string;
  rootCause: string;
  countermeasure: string;
  supplier: string;
  closedAt: string;
}

export interface Complaint {
  id: string;
  customer: string;
  product: string;
  batch: string;
  symptom: string;
  category: string;
  severity: string;
  status: string;
  receivedAt: string;
  owner: string;
  caseId: string | null;
}

export interface Capa {
  id: string;
  complaintId: string;
  title: string;
  owner: string;
  due: string;
  status: string;
}

export function listCases(db: DB): QualityCase[] {
  return (db.prepare('SELECT * FROM quality_cases ORDER BY closed_at DESC').all() as Row[]).map((r) => ({
    id: String(r.id),
    title: String(r.title),
    keywords: String(r.keywords ?? ''),
    product: String(r.product),
    category: String(r.category),
    symptom: String(r.symptom),
    rootCause: String(r.root_cause),
    countermeasure: String(r.countermeasure),
    supplier: String(r.supplier),
    closedAt: String(r.closed_at),
  }));
}

export function listComplaints(db: DB): Complaint[] {
  return (db.prepare('SELECT * FROM quality_complaints ORDER BY received_at DESC').all() as Row[]).map((r) => ({
    id: String(r.id),
    customer: String(r.customer),
    product: String(r.product),
    batch: String(r.batch),
    symptom: String(r.symptom),
    category: String(r.category),
    severity: String(r.severity),
    status: String(r.status),
    receivedAt: String(r.received_at),
    owner: String(r.owner),
    caseId: (r.case_id as string | null) ?? null,
  }));
}

export function listCapa(db: DB): Capa[] {
  return (db.prepare('SELECT * FROM quality_capa ORDER BY due').all() as Row[]).map((r) => ({
    id: String(r.id),
    complaintId: String(r.complaint_id),
    title: String(r.title),
    owner: String(r.owner),
    due: String(r.due),
    status: String(r.status),
  }));
}

export function isOverdue(capa: Capa, today: string): boolean {
  return !['已完成', '已取消'].includes(capa.status) && validDate(capa.due) && capa.due < today;
}

export function isClosedComplaint(complaint: Complaint): boolean {
  return ['已结案', '已关闭', '已取消'].includes(complaint.status);
}

export function complaintTrend(db: DB, today: string) {
  const complaints = listComplaints(db).filter((c) => c.status !== '已取消' && validDate(c.receivedAt) && c.receivedAt <= today);
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(today, i - 6));
  const daily = days.map((day) => ({ day, count: complaints.filter((c) => c.receivedAt === day).length }));
  const current = daily.reduce((sum, d) => sum + d.count, 0);
  const previous = complaints.filter((c) => c.receivedAt >= shiftDate(today, -13) && c.receivedAt < days[0]).length;
  return { current, previous, delta: current - previous, daily };
}

/**
 * Rank historical cases against a symptom description. Same category counts most, then the case's plain-word
 * keywords; product names are ignored.
 */
export function similarCases(db: DB, query: string, category?: string): { case: QualityCase; score: number; specific: boolean; terms: string[] }[] {
  const ids: string[] = query.toUpperCase().match(/\bQC-[A-Z0-9-]+\b/g) ?? [];
  if (ids.length) return listCases(db).filter((c) => ids.includes(c.id)).map((c) => ({ case: c, score: 100, specific: true, terms: [c.id] }));
  const clean = normalizeSymptom(query);
  return listCases(db)
    .map((c) => {
      const terms = c.keywords.split(/\s+/).filter((k) => k && clean.toLowerCase().includes(k.toLowerCase()));
      const evidence = 8 * terms.length + keywordScore(clean, `${c.title} ${c.symptom}`);
      return { case: c, terms, specific: terms.some((t) => !GENERIC_SYMPTOMS.has(t)), score: evidence >= 6 ? evidence + (category && normalizeSymptom(c.category) === normalizeSymptom(category) ? 20 : 0) : 0 };
    })
    .filter((r) => r.score >= 6)
    .sort((a, b) => b.score - a.score);
}
