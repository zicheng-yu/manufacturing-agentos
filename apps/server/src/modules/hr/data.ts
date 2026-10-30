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

const POLICY_ALIASES: Record<string, string> = {
  'P-01': '带薪年休 带薪休假 年度假',
  'P-02': '生病请假 诊断证明',
  'P-04': '周末上班 节假日上班 换休',
  'P-05': '晚班 通宵班',
  'P-06': '住酒店 酒店标准 吃饭补助 伙食补助 火车票 高铁票',
  'P-07': '五险 住房公积金',
  'P-08': '外训 资格证 培训费',
  'P-09': '离司 最后工作日',
  'P-10': '新人报到 新员工报到 入职材料',
};

/** Only explicit, elliptical follow-ups may reuse the immediately preceding topic. */
const FOLLOW_UP = /^(那|那么)?(我)?(入职\s*\d+\s*年了|没休完(怎么办)?|用不完(怎么办)?|能顺延|需要什么材料|要什么证明|提前几天(申请)?|多久内提交|上限多少|比例多少|这个怎么申请|这种情况怎么办)[呢吗？?。！!]*$/;
const UNCOVERED = /异地就医|生育津贴|班车|宿舍|落户|个税|收入证明|房贷|工资条|工资明细|报销进度|审批进度|劳动仲裁|赔偿|经济补偿|裁员|劳动合同|育儿假|丧假|探亲假|哺乳假|工伤|补卡|迟到|早退/;
const MISSING_DETAILS: Record<string, RegExp> = {
  'P-01': /折现|折算|折抵|跨公司|工龄认定/,
  'P-02': /工资|扣钱|扣薪|薪资|待遇/,
  'P-03': /几天|多少天|天数|工资|待遇/,
  'P-04': /几倍|倍率|时薪|多少钱/,
  'P-06': /超标|超出|垫付|发票丢|境外|国外|国际/,
  'P-07': /基数.*多少|多少.*基数|报销比例|提取|贷款|补缴|断缴|补办|转移/,
  'P-08': /没通过|未通过|考试失败|重考|提前离职|违约|内训|内部培训/,
};

export interface PolicyLookup {
  hits: { policy: Policy; score: number }[];
  gaps: string[];
}

export function lookupPolicies(db: DB, question: string, history: string[] = [], policies = listPolicies(db)): PolicyLookup {
  const match = (text: string) => policies
      .map((policy) => ({
        policy,
        whole: `${policy.keywords} ${POLICY_ALIASES[policy.id] ?? ''}`.split(/\s+/).filter((k) => k && !['请假', '休假'].includes(k) && text.includes(k)).length,
      }))
      .filter((r) => r.whole > 0)
      .map((r) => ({ policy: r.policy, score: r.whole * 10 + keywordScore(text, `${r.policy.title} ${r.policy.content}`) }))
      .sort((a, b) => b.score - a.score);

  const gaps: string[] = [];
  const uncovered = question.match(UNCOVERED)?.[0];
  if (uncovered) gaps.push(`制度库未覆盖「${uncovered}」的办理口径或个人记录，需 HR 人工答复`);
  let hits = match(question);
  if (!hits.length && !uncovered && FOLLOW_UP.test(question.trim())) {
    // Stop at an intervening topic change; do not revive a much older policy.
    for (const earlier of [...history].reverse()) {
      if (UNCOVERED.test(earlier)) break;
      hits = match(earlier);
      if (hits.length || !FOLLOW_UP.test(earlier.trim())) break;
    }
  }
  const ids = new Set(hits.map((h) => h.policy.id));
  for (const { policy } of hits) {
    const missing = question.match(MISSING_DETAILS[policy.id] ?? /$^/)?.[0];
    if (missing) gaps.push('《' + policy.title + '》未给出「' + missing + '」的具体口径，需 HR 核定');
  }
  if (ids.has('P-01') && /余额|剩余|还剩/.test(question)) gaps.push('制度库没有个人年假余额，需要 HR 核对个人记录');
  if (!hits.length && !gaps.length) gaps.push('制度库未覆盖该问题，需 HR 人工答复');
  return { hits, gaps };
}

export function searchPolicies(db: DB, question: string, history: string[] = []): { policy: Policy; score: number }[] {
  return lookupPolicies(db, question, history).hits;
}

export function daysOpen(position: Position, today: string): number {
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(position.openedAt)) / 86_400_000));
}
