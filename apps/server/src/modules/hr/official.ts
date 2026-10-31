// The four official regulations become the company policy assistant's published knowledge, one version per section,
// replacing the demo policy library. Keywords add the words employees actually use for the regulation's terms.
import type { DB } from '../../db.ts';
import { officialPolicies } from '../../seed/official.ts';

/** Matched against a section's title only: body text mentions many topics in passing (laws, glossaries). */
const SYNONYMS: [RegExp, string][] = [
  [/假期|休假|年休假/, '年假 年休假 带薪假 病假 婚假 产假 陪产假 丧假 育儿假 请假'],
  [/加班/, '加班 加班费 调休'],
  [/工时/, '上班时间 工时 排班'],
  [/薪酬|工资|薪资/, '工资 薪水 发薪 调薪'],
  [/福利|保险|公积金/, '社保 五险一金 公积金 福利'],
  [/差旅|费用|报销/, '出差 报销 住宿 差旅费'],
  [/离职|解除|辞职/, '辞职 离职 交接'],
  [/试用/, '试用期 转正'],
  [/培训|人才发展/, '培训 学习 课程 考证'],
  [/绩效/, '绩效 考核 KPI 打分'],
  [/考勤|打卡|旷工/, '考勤 打卡 迟到 早退 旷工'],
  [/招聘|录用|入职/, '招聘 入职 录用 背调'],
  [/呆滞/, '呆滞 呆料 积压库存'],
  [/采购|请购/, '采购 下单 请购 审批'],
  [/供应商/, '供应商 供方 评分 准入'],
  [/安全库存|订货/, '安全库存 补货 订货点'],
  [/8D|纠正与预防/, '8D 整改 纠正措施'],
  [/投诉/, '客诉 客户投诉'],
  [/不合格|特采|让步/, '不良 不合格品 特采'],
  [/AGV|AMR/, 'AGV 小车 搬运机器人'],
  [/电池|充电/, '充电 电池'],
  [/叉车/, '叉车'],
];

/** Purpose, scope, legal basis and glossary sections mention everything and answer nothing. */
const GENERAL = /^(目的|适用范围|法律依据|依据法律法规及标准|术语与定义)$/;

export function replaceWithOfficialPolicies(db: DB): void {
  db.exec('DELETE FROM hr_knowledge_versions; DELETE FROM hr_knowledge_documents; DELETE FROM hr_policies;');
  const doc = db.prepare(`INSERT INTO hr_knowledge_documents (id, kind) VALUES (?, 'policy')`);
  const version = db.prepare(
    `INSERT INTO hr_knowledge_versions (id, document_id, version, revision, status, title, category, keywords, content, scope, effective_from, published_by, published_at)
     VALUES (?, ?, 1, 1, 'published', ?, ?, ?, ?, '全体员工', ?, '赛道官方素材包', ?)`,
  );
  for (const p of officialPolicies()) {
    const extra = GENERAL.test(p.title) ? [] : SYNONYMS.filter(([re]) => re.test(p.title)).map(([, words]) => words);
    const keywords = [...new Set([p.title, p.chapter, ...extra.join(' ').split(' ')])].join(' ');
    doc.run(p.id);
    // The PDF text wraps table rows across lines, and the assistant splits clauses at line breaks; one line per
    // section keeps a table's conditions together (e.g. 年休假 tiers by 工龄).
    const content = p.text.split('\n').map((line) => line.trim()).filter(Boolean).join(' / ');
    version.run(`${p.id}-v1`, p.id, `${p.section} ${p.title}`, `${p.document}（${p.code} ${p.version}）`, keywords, content, p.effectiveFrom, p.effectiveFrom ?? '2025-01-01');
  }
}
