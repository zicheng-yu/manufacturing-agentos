import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate } from '../../core/util.ts';
import { daysOpen, listAttrition, listDepartments, listPositions } from './data.ts';
import { jobDescription, readStructuredInput, roleChoices, roleFromQuestion, screenCandidates, ScreeningSchema, SKILL_SCALE, trainingPlan, TrainingSchema } from './talent.ts';
import { policyContext } from './policy-agent.ts';

export const serviceAgent: AgentDefinition = {
  id: 'hr.service', module: 'hr', companyService: true,
  name: '公司制度助手',
  description: '查询公司现行制度与已审核 FAQ，带条款和版本回答，缺信息先追问，未覆盖转 HR',
  instructions: '只使用当前有效的已发布制度与已审核 FAQ；核对原文引用，不猜测个人记录，未覆盖时转 HR。',
  starters: ['我想请假', '年假有几天？没休完怎么办', '出差住宿报销标准是多少', '公司有班车吗？'],
  context: policyContext,
};

export const orgAgent: AgentDefinition = {
  id: 'hr.org',
  module: 'hr',
  name: '招聘与组织助手',
  description: '编制与在岗、关键岗位招聘进度、离职预警',
  instructions:
    '你负责招聘与组织健康。先说关键岗位与减员风险，再给招聘优先级建议。员工姓名与离职原因不对外提供，也不得猜测原因；被问到时说明请联系 HR 经理。',
  starters: ['哪些关键岗位还空着？', '供应链部的人员情况', '本月组织健康怎么样'],
  context({ db, now, input }) {
    const today = isoDate(now);
    const allDepartments = listDepartments(db);
    const requested = allDepartments.filter((d) => input.includes(d.name));
    const departments = requested.length ? requested : allDepartments;
    const inScope = (department: string) => departments.some((d) => d.name === department);
    const open = listPositions(db).filter((p) => p.status === '招聘中' && inScope(p.department));
    const critical = open.filter((p) => p.critical).sort((a, b) => daysOpen(b, today) - daysOpen(a, today));
    const attrition = listAttrition(db, isoDate(addDays(now, -30))).filter((a) => inScope(a.department));
    const byDept = new Map<string, number>();
    for (const a of attrition) byDept.set(a.department, (byDept.get(a.department) ?? 0) + 1);
    return {
      headline: critical.length ? `${critical.length} 个关键岗位空缺，最长 ${daysOpen(critical[0], today)} 天` : '关键岗位已全部到岗',
      blocks: [
        { title: '编制与在岗', lines: departments.map((d) => `${d.name}：在岗 ${d.actual} / 编制 ${d.plan}`) },
        {
          title: '关键岗位招聘',
          lines: critical.length
            ? critical.map((p) => `${p.department} ${p.title}：空缺 ${daysOpen(p, today)} 天，候选人 ${p.candidates}（${p.stage}）`)
            : ['无'],
        },
        {
          title: '30 天离职预警（姓名与原因不在此展示）',
          lines: attrition.length ? attrition.map((a) => `${a.department} ${a.position}（${a.reportedAt}）`) : ['无'],
        },
      ],
      facts: [
        ...critical.map((p) => `${p.department}${p.title}空缺 ${daysOpen(p, today)} 天`),
        ...[...byDept].map(([dept, n]) => `${dept} 30 天内 ${n} 人离职预警`),
      ],
      suggestions: critical.slice(0, 2).map((p) => `优先推进${p.department}${p.title}招聘（候选人 ${p.candidates} 人，${p.stage}）`),
      artifacts: [
        {
          kind: 'table',
          title: '组织健康',
          columns: ['部门', '编制', '在岗', '缺编', '招聘中关键岗位', '30 天离职预警'],
          rows: departments.map((d) => [
            d.name,
            d.plan,
            d.actual,
            Math.max(0, d.plan - d.actual),
            critical.filter((p) => p.department === d.name).map((p) => p.title).join('、') || '—',
            byDept.get(d.name) ?? 0,
          ]),
        },
      ],
    };
  },
};

export const recruitmentAgent: AgentDefinition = {
  id: 'hr.recruitment', module: 'hr', name: '招聘初筛助手',
  description: '按岗位要求起草 JD，用结构化技能与相关经验逐项核对简历，结果交 HR 复核',
  instructions: '只使用已录入岗位要求和本次结构化简历；技能、年限缺失或冲突时保留待核，不补造证据。不依据年龄、性别、婚育、籍贯等个人特征评分。不自动决定淘汰、录用或更改阶段。薪酬和班次未录入时标待核。',
  starters: ['为 POS-01 采购工程师生成 JD', '机器人仿真工程师的岗位职责和技能要求', '候选人初筛需要哪些资料？'],
  context({ db, input }) {
    if (input.includes('{') || /初筛|简历|打分|评分|候选人/.test(input)) {
      const parsed = ScreeningSchema.safeParse(readStructuredInput(input));
      if (!parsed.success) return {
        headline: '请提供岗位编号与结构化简历',
        blocks: [{ title: '候选人资料', lines: [SKILL_SCALE, '在 [HR 模块](/m/hr) 的招聘初筛表单选择岗位，填写候选人编号、相关工作年限和技能等级。'] }],
        pending: ['结构化简历缺失或格式无效，尚未进行评分'],
      };
      return screenCandidates(db, parsed.data);
    }
    const role = roleFromQuestion(db, input);
    return role ? jobDescription(db, role.positionId) : roleChoices(db);
  },
};

export const trainingAgent: AgentDefinition = {
  id: 'hr.training', module: 'hr', name: '岗位培训助手',
  description: '比较已评估技能与岗位要求，生成课程、学时、建议排期和考核标准',
  instructions: '只依据岗位要求、课程目录和本次技能评估生成计划。未填写的技能是未评估，不是零分。日期为建议排期，讲师、班次和人员需要部门负责人确认；不宣称培训已经完成。',
  starters: ['如何填写岗位技能评估？', '机器人仿真工程师需要哪些培训？'],
  context({ db, input, now }) {
    const parsed = TrainingSchema.safeParse(readStructuredInput(input));
    if (!parsed.success) return {
      headline: '请先提供岗位编号与技能评估',
      blocks: [{ title: '技能评估', lines: [SKILL_SCALE, '在 [HR 模块](/m/hr) 的岗位培训表单选择岗位，填写已评估的技能等级后生成计划。'] }],
      pending: ['尚未提供有效技能评估，不推测个人技能差距'],
      artifacts: roleChoices(db).artifacts,
    };
    return trainingPlan(db, parsed.data, now);
  },
};
