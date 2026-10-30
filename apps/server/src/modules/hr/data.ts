import type { DB, Row } from '../../db.ts';
import { keywordScore } from '../../core/util.ts';

export interface Department {
  id: string;
  name: string;
  plan: number;
  actual: number;
}

export interface Position {
  id: string;
  department: string;
  title: string;
  critical: boolean;
  status: string;
  openedAt: string;
  candidates: number;
  stage: string;
}

export interface Policy {
  id: string;
  category: string;
  title: string;
  /** Words employees actually use, e.g. 年假 for 年休假. */
  keywords: string;
  content: string;
}

export interface AttritionRisk {
  id: string;
  department: string;
  position: string;
  employeeName: string;
  reason: string;
  reportedAt: string;
}

export function listDepartments(db: DB): Department[] {
  return (db.prepare('SELECT * FROM hr_departments ORDER BY rowid').all() as Row[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    plan: Number(r.plan),
    actual: Number(r.actual),
  }));
}

export function listPositions(db: DB): Position[] {
  return (db.prepare('SELECT * FROM hr_positions ORDER BY opened_at').all() as Row[]).map((r) => ({
    id: String(r.id),
    department: String(r.department),
    title: String(r.title),
    critical: Number(r.critical) === 1,
    status: String(r.status),
    openedAt: String(r.opened_at),
    candidates: Number(r.candidates),
    stage: String(r.stage),
  }));
}

export function listPolicies(db: DB): Policy[] {
  return (db.prepare('SELECT * FROM hr_policies ORDER BY id').all() as Row[]).map((r) => ({
    id: String(r.id),
    category: String(r.category),
    title: String(r.title),
    keywords: String(r.keywords),
    content: String(r.content),
  }));
}

export function listAttrition(db: DB, since?: string): AttritionRisk[] {
  const rows = since
    ? (db.prepare('SELECT * FROM hr_attrition WHERE reported_at >= ? ORDER BY reported_at DESC').all(since) as Row[])
    : (db.prepare('SELECT * FROM hr_attrition ORDER BY reported_at DESC').all() as Row[]);
  return rows.map((r) => ({
    id: String(r.id),
    department: String(r.department),
    position: String(r.position),
    employeeName: String(r.employee_name),
    reason: String(r.reason),
    reportedAt: String(r.reported_at),
  }));
}

/** Title and keyword hits count double, so short questions like "年假有几天" still find their policy. */
export function searchPolicies(db: DB, question: string): { policy: Policy; score: number }[] {
  return listPolicies(db)
    .map((policy) => ({
      policy,
      score: 2 * keywordScore(question, `${policy.title} ${policy.keywords}`) + keywordScore(question, `${policy.category} ${policy.content}`),
    }))
    .filter((r) => r.score >= 4)
    .sort((a, b) => b.score - a.score);
}

export function daysOpen(position: Position, today: string): number {
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(position.openedAt)) / 86_400_000));
}
