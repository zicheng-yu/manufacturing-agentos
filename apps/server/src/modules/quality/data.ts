import type { DB, Row } from '../../db.ts';
import { keywordScore } from '../../core/util.ts';

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
  return capa.status !== '已完成' && capa.due < today;
}

/**
 * Rank historical cases against a symptom description. Same category counts most, then the case's plain-word
 * keywords; product names are ignored.
 */
export function similarCases(db: DB, query: string, category?: string): { case: QualityCase; score: number }[] {
  return listCases(db)
    .map((c) => ({
      case: c,
      score:
        (category && c.category === category ? 20 : 0) +
        8 * c.keywords.split(/\s+/).filter((k) => k && query.includes(k)).length +
        keywordScore(query, `${c.title} ${c.category} ${c.symptom} ${c.rootCause}`),
    }))
    .filter((r) => r.score >= 6)
    .sort((a, b) => b.score - a.score);
}
