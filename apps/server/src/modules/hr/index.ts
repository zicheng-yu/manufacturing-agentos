import type { Level } from '@agentos/shared';
import type { DomainModule } from '../../core/module.ts';
import { addDays, isoDate, newId } from '../../core/util.ts';
import { orgAgent, recruitmentAgent, serviceAgent, trainingAgent } from './agents.ts';
import { daysOpen, listAttrition, listDepartments, listPositions } from './data.ts';
import { listRequests, recordServiceRequest, REQUEST_SCHEMA, ServicePayload } from './requests.ts';
import { hrRoutes } from './routes.ts';
import { hrSeedEvents, seedHr } from './seed.ts';
import { replaceWithOfficialPolicies } from './official.ts';
import { listRoleProfiles } from './talent.ts';
import { activeKnowledge, KNOWLEDGE_SCHEMA } from './knowledge.ts';

const PRIVATE_FIELDS = ['employeeName', 'reason'];

export const hrModule: DomainModule = {
  id: 'hr',
  name: 'HR',
  description: '员工服务问答、招聘与组织健康：让人与组织服务更高效',
  schema: `
    CREATE TABLE IF NOT EXISTS hr_departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan INTEGER NOT NULL, actual INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hr_positions (
      id TEXT PRIMARY KEY, department TEXT NOT NULL, title TEXT NOT NULL, critical INTEGER NOT NULL,
      status TEXT NOT NULL, opened_at TEXT NOT NULL, candidates INTEGER NOT NULL, stage TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hr_policies (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hr_attrition (
      id TEXT PRIMARY KEY, department TEXT NOT NULL, position TEXT NOT NULL, employee_name TEXT NOT NULL,
      reason TEXT NOT NULL, reported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hr_requests (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    ${REQUEST_SCHEMA}
    ${KNOWLEDGE_SCHEMA}`,
  // The org chart and recruiting data stay as demo data (the pack has none); policies come from the official regulations.
  seed(ctx) {
    seedHr(ctx);
    if (ctx.dataset === 'official') replaceWithOfficialPolicies(ctx.db);
  },
  seedEvents: hrSeedEvents,
  agents: [serviceAgent, orgAgent, recruitmentAgent, trainingAgent],
  routes: hrRoutes,

  eventTypes: [
    {
      type: 'attrition_risk',
      label: '离职预警',
      severity: 'warn',
      kind: 'state',
      dedupeFields: ['employeeName'],
      hiddenFields: { supply_mgr: PRIVATE_FIELDS, quality_mgr: PRIVATE_FIELDS, logistics_mgr: PRIVATE_FIELDS },
    },
    { type: 'critical_vacancy', label: '关键岗位空缺', severity: 'warn', kind: 'state', dedupeFields: ['positionId'] },
    { type: 'service_backlog', label: '员工服务积压', severity: 'info' },
    { type: 'service_requested', label: '员工服务转人工', severity: 'info', kind: 'state', dedupeFields: ['accountId', 'questionKey'] },
  ],

  signalRules: [
    {
      id: 'hr-service-requests', types: ['service_requested'], windowMinutes: 7 * 24 * 60,
      threshold: 5, severity: 'warn',
      groupBy: (event) => ServicePayload.safeParse(event.payload).success ? '员工服务' : null,
      describe: (events) => ({ title: '员工服务请求积压', summary: `7 天内 ${events.length} 条转人工请求尚未解决，请 HR 安排答复` }),
      playbook: { decision: '安排 HR 分流答复并补充高频问题制度', impact: '未答复请求积压影响员工服务效率', owner: 'HR 经理', dueHours: 24, weight: 1 },
    },
    {
      id: 'hr-team-attrition',
      types: ['attrition_risk'],
      windowMinutes: 30 * 24 * 60,
      threshold: 2,
      severity: 'critical',
      groupBy: (e) => String(e.payload.department ?? '') || null,
      describe: (events, group) => ({
        title: `${group}减员预警`,
        summary: `30 天内 ${events.length} 人离职预警（${[...new Set(events.map((e) => String(e.payload.position ?? '')))].join('、')}）`,
      }),
      playbook: {
        decision: '批准关键岗位紧急招聘与留任方案，评估对交付的影响',
        impact: '关键岗位断档会放大供应与交付风险',
        owner: 'HR 经理与用人部门负责人',
        dueHours: 48,
        weight: 2,
      },
    },
    {
      id: 'hr-critical-vacancy',
      types: ['critical_vacancy'],
      windowMinutes: 30 * 24 * 60,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({
        title: `关键岗位空缺 ${events.length} 个`,
        summary: events.map((e) => e.summary).join('；'),
      }),
      playbook: {
        decision: '确认关键岗位招聘优先级与预算',
        impact: '关键岗位长期空缺会拖慢相关部门的工作',
        owner: 'HR 经理',
        dueHours: 72,
        weight: 1,
      },
    },
  ],

  situation({ db, now, signals }) {
    const departments = listDepartments(db);
    const plan = departments.reduce((s, d) => s + d.plan, 0);
    const actual = departments.reduce((s, d) => s + d.actual, 0);
    const vacancies = listPositions(db).filter((p) => p.critical && p.status === '招聘中');
    const attrition = listAttrition(db, isoDate(addDays(now, -30)));
    const level: Level = signals.some((s) => s.severity === 'critical') ? 'alert' : signals.length ? 'watch' : 'normal';
    const top = signals.find((s) => s.severity === 'critical') ?? signals[0];
    return {
      title: '组织健康',
      level,
      headline: top ? top.title : '人员编制整体稳定',
      metrics: [
        { label: '在岗 / 编制', value: `${actual} / ${plan}`, tone: 'neutral' },
        { label: '关键岗位空缺', value: vacancies.length, unit: '个', tone: vacancies.length ? 'bad' : 'good' },
        { label: '30 天离职预警', value: attrition.length, unit: '人', tone: attrition.length ? 'bad' : 'good' },
      ],
    };
  },

  overview({ db, now }) {
    const today = isoDate(now);
    const departments = listDepartments(db);
    const positions = listPositions(db);
    const requests = listRequests(db);
    return {
      metrics: [
        { label: '在岗', value: departments.reduce((s, d) => s + d.actual, 0), unit: '人' },
        { label: '缺编', value: departments.reduce((s, d) => s + Math.max(0, d.plan - d.actual), 0), unit: '人' },
        { label: '招聘中岗位', value: positions.filter((p) => p.status === '招聘中').length, unit: '个' },
        { label: '未解决员工请求', value: requests.filter((r) => r.status !== '已解决').length, unit: '条' },
      ],
      tables: [
        {
          kind: 'table',
          title: '部门编制',
          columns: ['部门', '编制', '在岗', '缺编'],
          rows: departments.map((d) => [d.name, d.plan, d.actual, Math.max(0, d.plan - d.actual)]),
        },
        {
          kind: 'table',
          title: '招聘岗位',
          columns: ['编号', '部门', '岗位', '关键岗位', '状态', '空缺天数', '候选人', '阶段'],
          rows: positions.map((p) => [
            p.id,
            p.department,
            p.title,
            p.critical ? '是' : '否',
            p.status,
            p.status === '招聘中' ? daysOpen(p, today) : '—',
            p.candidates,
            p.stage,
          ]),
        },
        {
          kind: 'table',
          title: '员工服务请求',
          columns: ['编号', '类别', '问题', '状态', '提交日期', '答复', '处理人', '关联事件'],
          rows: requests.map((r) => [r.id, r.category, r.question, r.status, r.createdAt, r.answer || '—', r.handledBy || '—', r.eventId || '—']),
          note: '在 HR 服务请求操作区填写答复；事件中心的确认 / 解决会同步请求状态。',
        },
        {
          kind: 'table', title: '岗位技能与培训目录', columns: ['岗位编号', '岗位', '技能', '目标等级', '对应课程', '学时'],
          rows: listRoleProfiles(db).flatMap((role) => role.skills.map((s) => [role.positionId, role.position.title, s.name, s.level, s.course, s.hours])),
          note: '在智能体工作台选择招聘初筛助手或岗位培训助手，提交结构化技能评估。',
        },
        {
          kind: 'table',
          title: '制度库',
          columns: ['编号', '类别', '制度', '内容'],
          rows: activeKnowledge(db, now).map((p) => [p.documentId + ' v' + p.version, p.category, p.title, p.content]),
          note: '演示制度，不构成法律意见',
        },
      ],
    };
  },

  onEvent({ db, now }, event, { created }) {
    if (event.type === 'service_requested') {
      if (created) recordServiceRequest(db, event, now);
      return;
    }
    if (event.type !== 'attrition_risk' || !created) return;
    const p = event.payload as Record<string, string | undefined>;
    db.prepare('INSERT INTO hr_attrition (id, department, position, employee_name, reason, reported_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      newId('ATR'),
      p.department ?? '',
      p.position ?? '',
      p.employeeName ?? '',
      p.reason ?? '',
      isoDate(now),
    );
  },
};
