import { z } from 'zod';
import type { AgentContext } from '../../core/module.ts';
import { addDays, isoDate, normalizeText } from '../../core/util.ts';
import type { DB } from '../../db.ts';
import { listPositions } from './data.ts';

// Demo role requirements and courses, maintained by HR, never inferred by the model.
export interface SkillRequirement {
  name: string;
  aliases: string[];
  level: number;
  weight: number;
  course: string;
  hours: number;
  assessment: string;
}

interface RoleProfile {
  positionId: string;
  aliases: string[];
  experienceYears: number;
  responsibilities: string[];
  skills: SkillRequirement[];
}

export const ROLE_PROFILES: RoleProfile[] = [
  {
    positionId: 'POS-01', aliases: ['采购工程师', '采购岗'], experienceYears: 3,
    responsibilities: ['执行寻源与询价，核对价格、交期及付款条件', '维护供应商绩效，跟进交付风险与替代货源', '协同品质与计划团队处理来料和缺料问题'],
    skills: [
      { name: '供应商管理', aliases: ['供应商绩效', 'SRM'], level: 2, weight: 30, course: '供应商准入与绩效复盘', hours: 6, assessment: '完成一份供应商绩效评审表并由采购主管复核' },
      { name: '成本分析', aliases: ['比价', '成本核算'], level: 2, weight: 30, course: '采购报价归一与成本拆解', hours: 4, assessment: '独立完成三家报价的税率、MOQ 与交期归一' },
      { name: 'ERP', aliases: ['SAP', '采购系统'], level: 2, weight: 20, course: '采购订单与到货跟踪实操', hours: 4, assessment: '在演练环境完成采购订单到收货的全流程' },
    ],
  },
  {
    positionId: 'POS-02', aliases: ['机器人仿真工程师', '仿真工程师'], experienceYears: 2,
    responsibilities: ['搭建料箱抓取与码垛仿真场景', '验证轨迹、碰撞与放置约束', '定位抓取失败并记录可复现的异常与指标'],
    skills: [
      { name: '机器人仿真', aliases: ['仿真', 'ROS'], level: 2, weight: 30, course: '料箱抓取与码垛仿真实训', hours: 8, assessment: '提交可重放的混合料箱抓取场景和失败日志' },
      { name: 'Python', aliases: ['python开发'], level: 2, weight: 20, course: 'Python 仿真控制与事件上报', hours: 6, assessment: '实现带异常处理的控制脚本并通过接口测试' },
      { name: '机器视觉', aliases: ['视觉识别', '计算机视觉'], level: 2, weight: 30, course: '料箱视觉识别与误差分析', hours: 8, assessment: '完成一组料箱识别评测并说明误判原因' },
    ],
  },
  {
    positionId: 'POS-03', aliases: ['SQE', '供应商质量工程师'], experienceYears: 3,
    responsibilities: ['执行供应商质量审核与来料异常分析', '组织 8D 改善跟踪及效果验证', '维护供应商品质案例与风险台账'],
    skills: [
      { name: '8D', aliases: ['8D分析', '8D报告'], level: 2, weight: 30, course: '8D 根因验证与闭环实训', hours: 6, assessment: '对一个演示客诉提交含验证证据的 8D 报告' },
      { name: '供应商审核', aliases: ['质量审核'], level: 2, weight: 30, course: '供应商过程审核', hours: 6, assessment: '完成一份审核清单及问题分级' },
      { name: 'SPC', aliases: ['统计过程控制'], level: 2, weight: 20, course: 'SPC 过程能力与控制图', hours: 4, assessment: '依据样本数据识别异常点并解释处置方法' },
    ],
  },
  {
    positionId: 'POS-04', aliases: ['产线技术员', '技术员'], experienceYears: 1,
    responsibilities: ['按作业指导书完成换线与设备点检', '记录产线异常并执行首件确认', '遵守现场安全和质量追溯要求'],
    skills: [
      { name: '设备点检', aliases: ['点检'], level: 2, weight: 30, course: '产线设备点检实操', hours: 4, assessment: '独立完成点检表并发现预置异常' },
      { name: '首件检验', aliases: ['首检'], level: 2, weight: 30, course: '首件确认与质量追溯', hours: 4, assessment: '完成一次首件检验和记录归档' },
      { name: '安全操作', aliases: ['安全作业'], level: 2, weight: 20, course: '现场安全操作实训', hours: 4, assessment: '通过现场操作考核后由主管确认上岗' },
    ],
  },
];

export const SKILL_SCALE = '技能等级：0=未掌握，1=了解，2=可独立完成，3=可指导他人；未填写表示未评估。';

const SkillSchema = z.object({ name: z.string().trim().min(1).max(80), level: z.number().int().min(0).max(3) }).strict();
const SkillsSchema = z.array(SkillSchema).max(30);
export const ScreeningSchema = z.object({
  positionId: z.string().trim().min(1).max(40),
  candidates: z.array(z.object({
    id: z.string().trim().min(1).max(40),
    experienceYears: z.number().min(0).max(60).optional(),
    skills: SkillsSchema,
  }).strict()).min(1).max(20),
}).strict().refine((v) => new Set(v.candidates.map((c) => c.id)).size === v.candidates.length, '候选人编号不能重复');
export const TrainingSchema = z.object({ positionId: z.string().trim().min(1).max(40), skills: SkillsSchema }).strict();
export type ScreeningInput = z.infer<typeof ScreeningSchema>;
export type TrainingInput = z.infer<typeof TrainingSchema>;

export function listRoleProfiles(db: DB) {
  const positions = listPositions(db);
  return ROLE_PROFILES.flatMap((profile) => {
    const position = positions.find((p) => p.id === profile.positionId);
    return position ? [{ ...profile, position }] : [];
  });
}

export function findRole(db: DB, id: string) {
  return listRoleProfiles(db).find((r) => r.positionId === id.toUpperCase());
}

export function roleFromQuestion(db: DB, question: string) {
  const id = question.match(/POS-[\w-]+/i)?.[0];
  if (id) return findRole(db, id);
  const text = question.toLowerCase();
  const roles = listRoleProfiles(db).filter((r) => r.aliases.some((a) => text.includes(a.toLowerCase())));
  return roles.length === 1 ? roles[0] : undefined;
}

export function roleChoices(db: DB): AgentContext {
  return {
    headline: '请指定一个已收录岗位编号',
    blocks: [{ title: '岗位资料', lines: ['未找到唯一匹配的岗位；请从下表选择，未收录岗位需要 HR 补充要求。'] }],
    pending: ['请确认岗位编号及岗位要求'],
    artifacts: [{ kind: 'table', title: '可用岗位', columns: ['编号', '部门', '岗位'], rows: listRoleProfiles(db).map((r) => [r.positionId, r.position.department, r.position.title]) }],
  };
}

export function jobDescription(db: DB, positionId: string): AgentContext {
  const role = findRole(db, positionId);
  if (!role) return roleChoices(db);
  return {
    headline: `${role.position.title} · JD 草案`,
    blocks: [
      { title: '岗位', lines: [`${role.positionId} · ${role.position.department} · ${role.position.title}`, `岗位状态：${role.position.status}`] },
      { title: '岗位职责', lines: role.responsibilities },
      { title: '岗位要求', lines: [`相关工作经验 ${role.experienceYears} 年；${SKILL_SCALE}`, ...role.skills.map((s) => `${s.name}：等级 ${s.level}`)] },
      { title: '发布前确认', lines: ['薪酬范围、工作地点、班次与用工形式未录入，请 HR 确认后发布。'] },
    ],
    facts: [`${role.positionId} ${role.position.title}归属${role.position.department}`, ...role.skills.map((s) => `岗位要求：${s.name}等级 ${s.level}`)],
    pending: ['薪酬范围、工作地点、班次与用工形式待 HR 确认'],
  };
}

/** Conflicting duplicates are not resolved in the candidate's favour. Ask HR to verify. */
function assessedLevel(skills: TrainingInput['skills'], requirement: SkillRequirement): number | null {
  const names = [requirement.name, ...requirement.aliases].map(normalizeText);
  const levels = new Set(skills.filter((s) => names.includes(normalizeText(s.name))).map((s) => s.level));
  return levels.size === 1 ? [...levels][0] : null;
}

export function screenCandidates(db: DB, raw: ScreeningInput): AgentContext {
  const input = ScreeningSchema.parse(raw);
  const role = findRole(db, input.positionId);
  if (!role) return roleChoices(db);
  const rows: (string | number)[][] = [];
  const pending: string[] = [];
  const facts: string[] = [];
  for (const candidate of input.candidates) {
    let points = 0;
    let complete = true;
    for (const skill of role.skills) {
      const level = assessedLevel(candidate.skills, skill);
      const earned = level === null ? null : Math.round(Math.min(level / skill.level, 1) * skill.weight);
      points += earned ?? 0;
      if (earned === null) {
        complete = false;
        pending.push(`${candidate.id}：${skill.name}未评估或记录冲突，请人工核实`);
      }
      rows.push([candidate.id, skill.name, `等级 ${skill.level}`, level === null ? '未评估 / 记录冲突' : `等级 ${level}`, skill.weight, earned ?? '待核', skill.assessment]);
    }
    const years = candidate.experienceYears;
    const experiencePoints = years === undefined ? null : Math.round(Math.min(years / role.experienceYears, 1) * 20);
    points += experiencePoints ?? 0;
    if (years === undefined) {
      complete = false;
      pending.push(`${candidate.id}：相关工作年限未提供，请人工核实`);
    }
    rows.push([candidate.id, '相关工作经验', `${role.experienceYears} 年`, years === undefined ? '未提供' : `${years} 年`, 20, experiencePoints ?? '待核', '核对项目经历与实际职责']);
    rows.push([candidate.id, '合计', '100 分', complete ? '字段齐全，证据待面试复核' : '信息不足，不给总分', 100, complete ? points : '待核', '由 HR 与用人部门决定后续流程']);
    facts.push(complete ? `${candidate.id}：按所填技能与相关经验计算 ${points}/100 分` : `${candidate.id}：信息不足，暂不计算总分`);
  }
  return {
    headline: `${role.position.title} · ${input.candidates.length} 份结构化简历核对`,
    blocks: [
      { title: '评分依据', lines: ['岗位技能占 80 分，相关经验占 20 分；每项按已填水平与岗位要求的比例计分，超过要求不额外加分。', SKILL_SCALE] },
      { title: '核对结果', lines: facts },
      { title: '人工复核', lines: ['输入为申报信息，尚未核验。分数只用于组织面试核对；不自动淘汰、排序录用或改变招聘阶段。'] },
    ],
    facts,
    pending,
    suggestions: ['按逐项证据安排面试，由 HR 与用人部门共同复核'],
    artifacts: [{ kind: 'table', title: '候选人逐项核对', columns: ['候选人编号', '项目', '岗位要求', '申报证据', '权重', '得分', '面试核对'], rows }],
  };
}

export function trainingPlan(db: DB, raw: TrainingInput, now: Date): AgentContext {
  const input = TrainingSchema.parse(raw);
  const role = findRole(db, input.positionId);
  if (!role) return roleChoices(db);
  const rows: (string | number)[][] = [];
  const pending: string[] = [];
  const actions: NonNullable<AgentContext['actions']> = [];
  let hours = 0;
  let week = 0;
  for (const skill of role.skills) {
    const current = assessedLevel(input.skills, skill);
    if (current === null) {
      pending.push(`${skill.name}未评估或记录冲突，先完成技能评估`);
      rows.push([skill.name, '未评估', skill.level, '待核', '先做技能评估', '—', '—', skill.assessment]);
      actions.push({ title: `${role.positionId} ${skill.name}技能评估`, owner: `${role.position.department}负责人`, due: isoDate(addDays(now, 3)) });
      continue;
    }
    if (current >= skill.level) continue;
    hours += skill.hours;
    const due = isoDate(addDays(now, ++week * 7));
    rows.push([skill.name, current, skill.level, skill.level - current, skill.course, skill.hours, due, skill.assessment]);
    actions.push({ title: `${role.positionId} ${skill.course}及考核`, owner: `${role.position.department}负责人`, due });
  }
  return {
    headline: hours ? `${role.position.title}：建议培训 ${hours} 学时` : pending.length ? '先补齐技能评估，再确认培训计划' : `${role.position.title}：已评估技能达到岗位要求`,
    blocks: [
      { title: '计划依据', lines: [`${role.positionId} ${role.position.title}的岗位技能要求与本次结构化评估；${SKILL_SCALE}`] },
      { title: '培训安排', lines: hours ? [`已确认差距对应 ${week} 门课程、${hours} 学时，每周一门；完成后按表中标准考核。`, '日期为建议排期，需用人部门确认讲师、班次和参训人员。'] : ['没有已确认的技能差距时，不生成补课任务。'] },
    ],
    facts: [`已确认技能差距 ${week} 项，建议培训 ${hours} 学时`],
    pending,
    actions,
    artifacts: [{ kind: 'table', title: '岗位技能差距与培训计划', columns: ['技能', '当前等级', '目标等级', '差距', '课程 / 下一步', '学时', '建议完成日期', '验收标准'], rows }],
  };
}

/** Read one explicitly supplied JSON object; malformed input never falls back to demo evidence. */
export function readStructuredInput(input: string): unknown {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(input.slice(start, end + 1)); } catch { return null; }
}
