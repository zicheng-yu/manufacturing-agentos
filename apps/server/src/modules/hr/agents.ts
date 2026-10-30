import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate } from '../../core/util.ts';
import { daysOpen, listAttrition, listDepartments, listPositions, searchPolicies } from './data.ts';

export const serviceAgent: AgentDefinition = {
  id: 'hr.service',
  module: 'hr',
  name: '员工服务助手',
  description: '基于制度库回答考勤、假期、社保、报销等高频问题，答不了的转人工',
  instructions: '你负责员工服务问答。只依据制度库原文回答并注明制度编号；制度库没有覆盖的问题不要推测，写进 pending 并建议转 HR 人工处理。',
  starters: ['年假有几天？没休完怎么办', '出差住宿报销标准是多少', '异地就医备案怎么办理'],
  context({ now, input, db }) {
    const hits = searchPolicies(db, input).slice(0, 2);
    if (hits.length === 0) {
      return {
        headline: '制度库未覆盖该问题，已转 HR 人工处理',
        blocks: [{ title: '制度检索', lines: ['未找到相关制度'] }],
        pending: ['制度库未覆盖该问题，需 HR 人工答复'],
        actions: [{ title: `HR 人工答复：${input.slice(0, 30)}`, owner: 'HR 经理', due: isoDate(addDays(now, 1)) }],
      };
    }
    return {
      headline: `依据《${hits[0].policy.title}》（${hits[0].policy.id}）`,
      blocks: hits.map((h) => ({ title: `${h.policy.id} ${h.policy.title}`, lines: [h.policy.content] })),
      facts: hits.map((h) => `${h.policy.id}《${h.policy.title}》：${h.policy.content}`),
    };
  },
};

export const orgAgent: AgentDefinition = {
  id: 'hr.org',
  module: 'hr',
  name: '招聘与组织助手',
  description: '编制与在岗、关键岗位招聘进度、离职预警',
  instructions: '你负责招聘与组织健康。先说关键岗位与减员风险，再给招聘优先级建议；涉及员工个人信息时只在必要时提及。',
  starters: ['哪些关键岗位还空着？', '供应链部的人员情况', '本月组织健康怎么样'],
  context({ db, now }) {
    const today = isoDate(now);
    const departments = listDepartments(db);
    const open = listPositions(db).filter((p) => p.status === '招聘中');
    const critical = open.filter((p) => p.critical).sort((a, b) => daysOpen(b, today) - daysOpen(a, today));
    const attrition = listAttrition(db, isoDate(addDays(now, -30)));
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
          title: '30 天离职预警',
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
