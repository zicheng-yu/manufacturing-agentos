import type { Discovery, TableArtifact } from '@agentos/shared';
import { discoveryAgent } from './discoveries.ts';
import type { DB } from '../db.ts';
import type { AgentDefinition } from '../core/module.ts';
import { percent, round } from '../core/util.ts';
import { confirmedPrecursors } from '../modules/production/evidence.ts';
import { compareStrategies, STRATEGY_LABEL } from '../modules/production/data.ts';
import { inventoryExposure } from '../modules/supply/evidence.ts';
import { agvSummary } from '../modules/logistics/agv.ts';
import { aoiSummary, ncSummary } from '../modules/quality/official.ts';
import { listEnergy } from '../modules/ehs/data.ts';

export interface Finding {
  id: string;
  title: string;
  observation: string;
  basis: string;
  boundary: string;
  table: TableArtifact;
}
const table = (title: string, columns: string[], rows: TableArtifact['rows'], note: string): TableArtifact => ({ kind: 'table', title, columns, rows, note });
const SOURCE = '官方仿真素材包，基于平台已入库业务表重算';

/** Read-only, recomputed from the platform DB: no fixed result numbers and no model-invented findings. */
export function officialFindings(db: DB, now: Date): Finding[] {
  const findings: Finding[] = [];
  const leads = confirmedPrecursors(db);
  const matched = leads.filter((p) => p.hoursAhead !== null);
  if (leads.length) findings.push({
    id: 'equipment-confirmed-warning', title: '预警触发时间核验',
    observation: `${matched.length}/${leads.length} 条故障维修记录前满足24小时内3次关注区读数，触发后至故障平均 ${matched.length ? round(matched.reduce((s, p) => s + p.hoursAhead!, 0) / matched.length, 1) : '—'} 小时`,
    basis: '表02+03；逐设备回看故障前72小时，取第3条满足24小时窗口的读数；同一时间戳只计一次',
    boundary: '这是故障样本回看，未计算无故障时段误报率，不能称为全部故障均可预测；不把第一次异常当成规则触发时间',
    table: table('预警回看证据', ['维修单', '设备', '故障时间', '首次异常', '实际满足规则时间', '提前(小时)'], leads.map((p) => [p.repair.id, p.repair.equipmentId, p.repair.occurredAt, p.first ?? '无', p.confirmedAt ?? '未满足', p.hoursAhead ?? '—']), SOURCE),
  });
  const inventory = inventoryExposure(db);
  if (inventory.count) findings.push({
    id: 'inventory-aging', title: '库存资金占用集中度',
    observation: `呆滞≥90天 ${inventory.rows.length}/${inventory.count} 条库存记录，金额 ${inventory.value} 元，占库存金额 ${inventory.share === null ? '—' : percent(inventory.share, 1)}`,
    basis: '表11；按库存数量×记录单价求和；90天是本次分析筛选线，不是制度阈值',
    boundary: '库存金额不是现金节省或可回收价值；需核对需求、可替代性和处置审批',
    table: table('呆滞库存金额明细', ['物料', '名称', '批次', '呆滞天数', '记录金额(元)'], inventory.rows.map((r) => [r.code, r.name, r.batch, r.days, round(r.value, 2)]), SOURCE),
  });
  const energy = listEnergy(db);
  const idle = energy.filter((r) => r.output === 0 && r.kwh > 0);
  const idleKwh = idle.reduce((s, r) => s + r.kwh, 0);
  if (energy.length) findings.push({
    id: 'zero-output-energy', title: '零产量时段用电线索',
    observation: `${idle.length}/${energy.length} 条车间小时记录产量为零但仍用电 ${round(idleKwh, 2)} kWh，对应记录电费 ${round(idle.reduce((s, r) => s + r.kwh * r.price, 0), 2)} 元`,
    basis: '表09；产量=0且用电量>0；按记录粒度计数，电费=电量×当期电价',
    boundary: '可能来自保温、辅机、待机或计量口径，不等于浪费；未核实前不承诺节省',
    table: table('零产量用电明细', ['日期', '小时', '车间', '用电(kWh)', '电价(元/kWh)', '记录电费(元)'], idle.map((r) => [r.date, r.hour, r.workshop, r.kwh, r.price, round(r.kwh * r.price, 2)]), SOURCE),
  });
  const agv = agvSummary(db);
  const vehicle = [...agv.byAgv].sort((a, b) => b.timeouts - a.timeouts || a.key.localeCompare(b.key))[0];
  if (vehicle) findings.push({
    id: 'agv-timeout-concentration', title: '配送超时集中度',
    observation: `${vehicle.key} 承担 ${vehicle.tasks}/${agv.valid} 单有效任务，贡献 ${vehicle.timeouts}/${agv.timeouts} 单超时（${agv.timeouts ? percent(vehicle.timeouts / agv.timeouts, 1) : '无超时'}）；另剔除 ${agv.invalid.length} 单起终点相同记录`,
    basis: `表12；${agv.window}；超时贡献按超时单数排名，同时保留各车任务量分母`,
    boundary: '任务量、路线和负载可能不同，不能直接归因为车辆故障；按时率不等于制度中的任务自动执行率',
    table: table('超时集中度证据', ['车辆', '任务量', '超时单数', '超时率', '超时贡献'], agv.byAgv.map((r) => [r.key, r.tasks, r.timeouts, percent(r.rate, 1), agv.timeouts ? percent(r.timeouts / agv.timeouts, 1) : '—']), SOURCE),
  });
  const aoi = aoiSummary(db);
  const high = aoi.escapes.filter((r) => r.confidence !== null && r.confidence >= 0.9);
  if (aoi.total) findings.push({
    id: 'aoi-high-confidence-escape', title: '高置信度也存在漏检',
    observation: `在 ${aoi.escapes.length} 条AI判PASS、人工复核NG的漏检中，${high.length} 条模型置信度≥0.9；仅按低置信度复核不能覆盖这些样本`,
    basis: '表04；AI判定与人工复核交叉核验；0.9为本次观察分组，不是生产放行规则',
    boundary: '人工复核仅作为素材中的参考标签；阈值试算使用同批样本，不能视作独立测试集效果',
    table: table('高置信度漏检追溯', ['检测时间', '工单', '工位', '设备', '模型置信度', '人工复核'], high.map((r) => [r.ts, r.workOrder, r.station, r.equipment, r.confidence!, r.manual]), SOURCE),
  });
  const nc = ncSummary(db);
  const fatal = nc.all.filter((r) => r.severity.startsWith('A'));
  const fatalOpen = fatal.filter((r) => !r.status.startsWith('D7'));
  if (nc.all.length) findings.push({
    id: 'fatal-closure-gap', title: '致命不良的闭环缺口',
    observation: `${fatalOpen.length}/${fatal.length} 条A级不良尚未进入D7–D8闭环，除了 ${nc.fatalWithout8d.length} 条未开单，还需跟踪已立项但未闭环的记录`,
    basis: '表10；按不良单号计数，严重等级A开头；闭环状态按原表D7–D8标签',
    boundary: '阶段标签不等于客户验收、根因验证证据或实际改善效果',
    table: table('A级不良未闭环明细', ['不良单', '日期', '工单', '工序', '现象', '8D状态'], fatalOpen.map((r) => [r.id, r.date, r.workOrder, r.process, r.defect, r.status]), SOURCE),
  });
  const plans = compareStrategies(db, now);
  if (plans.some((p) => p.rows.length)) findings.push({
    id: 'schedule-scenario', title: '排产方案差异是估算',
    observation: `${plans[0].rows.length} 张工单中，${STRATEGY_LABEL[plans[0].strategy]}方案预计延期 ${plans[0].late} 张；各方案在同一产能、交期与计算起点下比较`,
    basis: `表05–07+15；起算日 ${now.toISOString().slice(0, 10)}，调用平台既有有限产能排产计算`,
    boundary: '未计未录入的在制、物料约束、人员班表；策略对比不是上线前后实测改善',
    table: table('排产方案试算', ['策略', '工单数', '延期', '加权延期(天)', '无法排入'], plans.map((p) => [STRATEGY_LABEL[p.strategy], p.rows.length, p.late, p.weightedLateness, p.unplaceable.length]), SOURCE),
  });
  return findings;
}

export const insightsAgent: AgentDefinition = {
  id: 'executive.insights', module: 'executive', name: '数据发现助手', datasets: ['official'],
  description: '从平台官方素材记录重算数据发现，逐项列出样本、口径、明细与待核边界',
  instructions: '只引用本轮计算的观察；区分历史样本回看、当前状态和方案估算；不能把官方仿真样本写成真实生产效果。',
  starters: ['平台数据还有哪些发现？', '核验提前预警的计算口径', '查库存积压与零产量用电', 'AOI、8D和注塑参数还有什么发现？'],
  async context(args) {
    const context = await discoveryAgent.context(args);
    // Keep the unique findings already shipped on main and one public assistant/route.
    const topics = {
      'zero-output-energy': { domain: 'ehs', agentId: 'ehs.energy', pattern: /能耗|用电|电费|零产量/, question: '零产量用电有哪些证据，能直接当成浪费吗？' },
      'aoi-high-confidence-escape': { domain: 'quality', agentId: 'quality.aoi', pattern: /品质|AOI|置信度|漏检/i, question: '高置信度漏检有哪些样本，低置信度复核能全部覆盖吗？' },
      'fatal-closure-gap': { domain: 'quality', agentId: 'quality.defects', pattern: /品质|致命|不良|闭环|8D/i, question: '已立项但没有闭环的A级不良有哪些？' },
    } as const;
    const general = /全部|所有|还有哪些|更多|平台数据/.test(args.input) || !/故障|设备|预警|维修|排产|延期|OEE|停机|品质|AOI|8D|注塑|不良|AGV|物流|按时|配送|库存|供应|物料|呆滞|能耗|安全|用电|EHS/i.test(args.input);
    const extra = officialFindings(args.db, args.now).flatMap((f): Discovery[] => {
      const topic = topics[f.id as keyof typeof topics];
      if (!topic || (!general && !topic.pattern.test(args.input))) return [];
      return [{ id: f.id, domain: topic.domain, title: f.title, kind: '历史观察', summary: f.observation, source: f.basis, scope: '官方素材包记录；计算明细见证据表', limitation: f.boundary, agentId: topic.agentId, question: topic.question, evidence: f.table }];
    });
    const discoveries = [...(context.discoveries ?? []), ...extra];
    const headline = `从平台记录重算 ${discoveries.length} 项数据发现（官方仿真素材）`;
    return { ...context, headline, discoveries, facts: discoveries.map(d => `【${d.kind}】${d.summary}`),
      blocks: discoveries.map(d => ({ title: `${d.title}（${d.kind}）`, lines: [d.summary, `来源：${d.source}；范围：${d.scope}`, `边界：${d.limitation}`] })),
      preparedResponse: { mode: 'offline', answer: `${headline}。展开下方卡片查看计算证据，或交给领域助手继续分析。历史观察、规则回测和情景估算均不代表实际已实现收益。` },
    };
  },
};
