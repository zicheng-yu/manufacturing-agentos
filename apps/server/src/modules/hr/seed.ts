import type { EventInput } from '../../core/events.ts';
import type { ModuleCtx } from '../../core/module.ts';
import { addDays, isoDate } from '../../core/util.ts';
import { IMPORT_LEGACY_POLICIES } from './knowledge.ts';

const DEPARTMENTS = [
  ['D-GM', '总经办', 6, 6],
  ['D-SC', '供应链部', 18, 17],
  ['D-QA', '品质部', 22, 21],
  ['D-PR', '生产部', 160, 152],
  ['D-LG', '智能物流部', 26, 24],
  ['D-RD', '研发部', 45, 43],
  ['D-HR', '人力资源部', 8, 8],
  ['D-FN', '财务部', 9, 9],
] as const;

// Demo company policies, not legal advice.
const POLICIES = [
  ['P-01', '假期', '年休假', '年假 年休假 带薪假 休假 请假 休完 顺延 没休 工龄 入职满', '入职满 1 年享 5 天带薪年假，满 10 年 10 天，满 20 年 15 天。当年未休完的年假可顺延至次年 3 月 31 日。请假需提前 3 个工作日在系统提交。'],
  ['P-02', '假期', '病假', '病假 生病 看病 医院证明', '病假需提供二级及以上医院出具的病假证明，3 天以内由部门经理审批，超过 3 天需 HR 备案。'],
  ['P-03', '假期', '婚假、产假与陪产假', '婚假 产假 陪产假 结婚 生育 怀孕', '婚假、产假、陪产假天数按国家及江苏省规定执行，具体天数由 HR 根据个人情况核定。申请时需提交结婚证或出生医学证明。'],
  ['P-04', '考勤', '加班与调休', '加班 调休 加班费 倒休', '工作日加班优先安排调休，调休须在 3 个月内使用完毕；休息日、法定节假日加班按国家规定计发加班费。加班需提前在系统申请。'],
  ['P-05', '薪酬', '夜班补贴', '夜班 夜班费 夜班补贴', '夜班（22:00–次日 6:00）每班补贴 30 元，随当月工资发放。'],
  ['P-06', '报销', '差旅报销标准', '出差 差旅 住宿 报销 餐补 交通', '国内出差住宿：直辖市及省会城市每晚 500 元以内，其他城市每晚 350 元以内；餐补每天 100 元；交通以高铁二等座为准。出差返回后 15 天内提交报销。'],
  ['P-07', '福利', '社保与公积金', '社保 公积金 五险一金 缴费基数', '按苏州市规定缴纳五险一金，公积金单位与个人比例各 8%；缴费基数每年 7 月统一调整。'],
  ['P-08', '培训', '外部培训与认证补贴', '培训 认证 考证 培训补贴 认证补贴', '与岗位相关的外部认证培训需提前申请，考试通过后报销 80% 费用，单次上限 5000 元；享受补贴需签订 1 年服务期协议。'],
  ['P-09', '入离职', '离职办理', '离职 辞职 交接 离职证明', '正式员工提前 30 天、试用期员工提前 3 天书面提出；离职前完成工作交接与资产归还，HR 在最后工作日出具离职证明。'],
  ['P-10', '入离职', '入职准备', '入职手续 入职准备 报到 入职体检 工牌 入职当天', '入职当天携带身份证、学历证明、前单位离职证明与入职体检报告；工牌和系统账号在入职当天开通。'],
] as const;

export function seedHr({ db, now }: ModuleCtx): void {
  const day = (n: number) => isoDate(addDays(now, n));
  const dept = db.prepare('INSERT INTO hr_departments (id, name, plan, actual) VALUES (?, ?, ?, ?)');
  for (const d of DEPARTMENTS) dept.run(...d);

  const position = db.prepare(
    'INSERT INTO hr_positions (id, department, title, critical, status, opened_at, candidates, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  position.run('POS-01', '供应链部', '采购工程师', 1, '招聘中', day(-21), 4, '复试');
  position.run('POS-02', '智能物流部', '机器人仿真工程师', 1, '招聘中', day(-35), 2, '初筛');
  position.run('POS-03', '品质部', 'SQE 供应商质量工程师', 1, '招聘中', day(-14), 5, '复试');
  position.run('POS-04', '生产部', '产线技术员', 0, '招聘中', day(-7), 12, '面试');
  position.run('POS-05', '研发部', '显示驱动工程师', 1, '已到岗', day(-60), 0, '已入职');

  const policy = db.prepare('INSERT INTO hr_policies (id, category, title, keywords, content) VALUES (?, ?, ?, ?, ?)');
  for (const p of POLICIES) policy.run(...p);
  db.exec(IMPORT_LEGACY_POLICIES);

  const request = db.prepare('INSERT INTO hr_requests (id, category, question, status, created_at) VALUES (?, ?, ?, ?, ?)');
  request.run('REQ-301', '社保', '异地就医备案怎么办理？', '待处理', day(-1));
  request.run('REQ-302', '证明', '需要开具收入证明用于房贷', '待处理', day(0));
}

export function hrSeedEvents(now: Date): EventInput[] {
  return [
    {
      domain: 'hr',
      type: 'critical_vacancy',
      title: '关键岗位空缺：采购工程师',
      summary: '供应链部采购工程师空缺 21 天，复试中 4 人',
      payload: { positionId: 'POS-01', department: '供应链部', position: '采购工程师', daysOpen: 21 },
      source: { channel: 'seed', actor: 'HR 经理' },
      at: addDays(now, -7),
    },
    {
      domain: 'hr',
      type: 'critical_vacancy',
      title: '关键岗位空缺：SQE 供应商质量工程师',
      summary: '品质部 SQE 供应商质量工程师空缺 14 天，复试中 5 人',
      payload: { positionId: 'POS-03', department: '品质部', position: 'SQE 供应商质量工程师', daysOpen: 14 },
      source: { channel: 'seed', actor: 'HR 经理' },
      at: addDays(now, -4),
    },
    {
      domain: 'hr',
      type: 'critical_vacancy',
      title: '关键岗位空缺：机器人仿真工程师',
      summary: '智能物流部机器人仿真工程师空缺 35 天，初筛中 2 人',
      payload: { positionId: 'POS-02', department: '智能物流部', position: '机器人仿真工程师', daysOpen: 35 },
      source: { channel: 'seed', actor: 'HR 经理' },
      at: addDays(now, -5),
    },
  ];
}
