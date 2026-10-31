import type { Discovery, TableArtifact } from '@agentos/shared';
import type { AgentDefinition } from '../core/module.ts';
import type { DB, Row } from '../db.ts';
import { round } from '../core/util.ts';
import { equipmentHealth, listRepairs, lineOee, plantLosses, compareStrategies, STRATEGY_LABEL, warningAudit } from '../modules/production/data.ts';
import { aoiSummary, ncSummary } from '../modules/quality/official.ts';
import { agvSummary } from '../modules/logistics/agv.ts';
import { listEnergy, listSafety, HIGH_RISK, OPEN_STATUSES } from '../modules/ehs/data.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (n: number, d: number) => d ? `${round(n / d * 100, 1)}%` : '无可用分母';
const mean = (xs: number[]) => xs.length ? sum(xs) / xs.length : 0;
const table = (title: string, columns: string[], rows: (string | number)[][]): TableArtifact => ({ kind: 'table', title, columns, rows });
function group<T>(rows: T[], key: (r: T) => string, value: (r: T) => number) {
  const buckets = new Map<string, number>();
  for (const row of rows) buckets.set(key(row), (buckets.get(key(row)) ?? 0) + value(row));
  return [...buckets].sort((a, b) => b[1] - a[1]);
}

/** Recomputed from the OS database on every request; no numbers are pasted from an offline report. */
export function discover(db: DB, now: Date): Discovery[] {
  const found: Discovery[] = [];
  const add = (d: Discovery) => found.push(d);
  const health = equipmentHealth(db);
  const repairs = listRepairs(db);
  const audit = warningAudit(db);
  if (repairs.length) {
    const leads = health.flatMap(h => h.precursors);
    add({ id: 'equipment-warning', domain: 'production', title: '预警覆盖与告警负担', kind: '规则回测',
      summary: `${repairs.length} 次已记录故障中 ${leads.length} 次在前72小时被规则覆盖；从实际触发时刻算平均提前 ${round(mean(leads.map(l => l.hoursAhead)), 1)} 小时。${audit.mature} 次有完整后续观察的告警中 ${audit.unmatched} 次在72小时内未匹配维修记录。`,
      source: '02_设备传感器时序 + 03_设备故障维修记录', scope: audit.window,
      limitation: '规则：过去24小时≥3个有效读数达到2.8 mm/s，从第3次开始触发。未匹配记录不等于确定误报；历史覆盖不保证未来故障全部可预测。',
      agentId: 'production.equipment', question: '按实际触发时刻，预警能提前多久？还有多少未匹配故障的告警？',
      evidence: table('故障与实际预警时刻', ['维修单', '设备', '故障时间', '触发时间', '提前小时'], repairs.map(r => { const lead = leads.find(l => l.repair.id === r.id); return [r.id, r.equipmentId, r.occurredAt, lead?.confirmedAt ?? '未覆盖', lead?.hoursAhead ?? '—']; })) });
    const ranked = group(repairs, r => r.equipmentId, r => r.downtimeMin);
    const top = ranked.slice(0, 2);
    add({ id: 'repair-concentration', domain: 'production', title: '维修损失集中在哪些设备', kind: '历史观察',
      summary: `${top.map(r => r[0]).join('、')} 两台合计停机 ${sum(top.map(r => r[1]))} 分钟，占维修记录停机的 ${pct(sum(top.map(r => r[1])), sum(repairs.map(r => r.downtimeMin)))}；全样本维修费 ${sum(repairs.map(r => r.cost))} 元。`,
      source: '03_设备故障维修记录', scope: `${repairs.length} 张维修单；${repairs[0].occurredAt} 至 ${repairs.at(-1)!.occurredAt}`,
      limitation: '停机、维修费用是历史损失，不能全部当成可节省收益；损失产量不等于订单延期。', agentId: 'production.equipment', question: `${top[0][0]} 的维修损失和预警证据是什么？`,
      evidence: table('按设备排维修损失', ['设备', '维修单数', '停机分钟', '维修费元', '损失产量件'], ranked.map(([id, minutes]) => { const rs = repairs.filter(r => r.equipmentId === id); return [id, rs.length, minutes, sum(rs.map(r => r.cost)), sum(rs.map(r => r.lostOutput))]; })) });
  }
  const oee = lineOee(db);
  if (oee.length) {
    const losses = plantLosses(db);
    const top = losses[0];
    add({ id: 'oee-loss', domain: 'production', title: '停机治理的首要方向', kind: '历史观察',
      summary: `最近7个记录日，「${top.reason}」为主因的线日累计停机 ${round(top.downtimeMin, 1)} 分钟，占全部停机 ${pct(top.downtimeMin, sum(losses.map(l => l.downtimeMin)))}。`,
      source: '15_OEE日统计', scope: `${oee.length} 条线，最近7个记录日`, limitation: '每行只有主要停机原因；这里按主因分组汇总整日停机，不能当成该原因的精确损失，也不能直接换算改善收益。',
      agentId: 'production.oee', question: '最近一周停机主要集中在哪些原因和产线？',
      evidence: table('按每日主要原因分组', ['主要原因', '线日数', '该组整日停机分钟', '占全部停机'], losses.map(l => [l.reason, l.days, round(l.downtimeMin, 1), pct(l.downtimeMin, sum(losses.map(x => x.downtimeMin)))])) });
  }
  const plans = compareStrategies(db, now);
  if (plans[0].rows.length) {
    const baseline = plans.find(p => p.strategy === 'priority')!;
    const best = plans[0];
    add({ id: 'schedule-tradeoff', domain: 'production', title: '排产策略的交期与换型权衡', kind: '情景估算',
      summary: `同一批 ${best.rows.length + best.unplaceable.length} 张工单，优先级策略预计延期 ${baseline.late} 张；${STRATEGY_LABEL[best.strategy]}预计延期 ${best.late} 张，加权延期 ${baseline.weightedLateness} → ${best.weightedLateness} 天。`,
      source: '05_生产工单 + 06_换型矩阵 + 07_产线产能 + 15_OEE', scope: `以 ${now.toISOString().slice(0, 10)} 为计划基准，从次日起排产`,
      limitation: '相同产能与日期假设下的算法方案比较；不是已发生的交付改善。未验证物料齐套、班次日历和临时停机，无 BOM 不能把线束缺料直接扣到具体工单。',
      agentId: 'production.schedule', question: '比较排产方案的延期、战略客户风险和换型成本，哪些前提还需确认？',
      evidence: table('同口径策略比较', ['方案', '已排/总单数', '延期单', '战略客户延期', '加权延期天', '换型分钟'], plans.map(p => [STRATEGY_LABEL[p.strategy], `${p.rows.length}/${p.rows.length + p.unplaceable.length}`, p.late, p.rows.filter(r => r.late && r.order.tier === '战略客户').length, p.weightedLateness, sum(p.rows.map(r => r.changeoverMin))])) });
  }
  const aoi = aoiSummary(db);
  if (aoi.total) {
    const top = aoi.byStation.slice(0, 2);
    add({ id: 'aoi-hotspots', domain: 'quality', title: 'AOI 漏检的复核优先级', kind: '历史观察',
      summary: `${top.map(p => p.key).join('、')} 合计 ${sum(top.map(p => p.value))}/${aoi.escapes.length} 件漏检，占 ${pct(sum(top.map(p => p.value)), aoi.escapes.length)}；人工判NG样本中漏检比例 ${pct(aoi.escapeRate, 1)}，人工判PASS样本中过杀比例 ${pct(aoi.falseCallRate, 1)}。`,
      source: '04_AOI视觉检测记录', scope: `${aoi.total} 次检测；以人工复核为样本标签`, limitation: '热点按漏检数量排序，不是工位风险率；工位检测量不同，不能仅据数量判定模型质量高低。',
      agentId: 'quality.aoi', question: 'AOI 漏检优先复核哪些工位？阈值是否能降低漏检？',
      evidence: table('漏检工位分布', ['工位/设备', '漏检件数', '占全部漏检'], aoi.byStation.map(p => [p.key, p.value, pct(p.value, aoi.escapes.length)])) });
    const rows = db.prepare('SELECT * FROM quality_aoi ORDER BY ts, id').all() as Row[];
    const split = Math.floor(rows.length * 0.7), train = rows.slice(0, split), holdout = rows.slice(split);
    const pass = (rs: Row[]) => rs.filter(r => r.ai === 'PASS');
    const missed = (rs: Row[]) => pass(rs).filter(r => String(r.manual).startsWith('NG'));
    const selected = aoi.options.map(o => ({ threshold: o.threshold, reviews: pass(train).filter(r => Number(r.confidence ?? 0) < o.threshold).length, caught: missed(train).filter(r => Number(r.confidence ?? 0) < o.threshold).length }))
      .filter(o => o.reviews <= pass(train).length * 0.2).sort((a, b) => b.caught - a.caught || a.reviews - b.reviews)[0];
    if (selected && holdout.length) {
      const reviewed = pass(holdout).filter(r => Number(r.confidence ?? 0) < selected.threshold);
      const captured = reviewed.filter(r => String(r.manual).startsWith('NG')).length;
      add({ id: 'aoi-holdout', domain: 'quality', title: '转人工阈值在后段样本上是否有效', kind: '规则回测',
        summary: `前70%样本选出阈值 ${selected.threshold}，后30%固定验证：额外复核 ${reviewed.length}/${pass(holdout).length} 件 PASS，拦截 ${captured}/${missed(holdout).length} 件漏检；剩余 ${missed(holdout).length - captured} 件。`,
        source: '04_AOI视觉检测记录', scope: `按时间/id分割：前 ${train.length} 条选阈值，后 ${holdout.length} 条验证`,
        limitation: '仅一次时间留出回测；20%复核预算只在前段约束，后段可能超支。无效果也照实展示，不宣传未经验证的提升。', agentId: 'quality.aoi', question: '复核阈值在后段样本拦截了多少漏检、增加多少人工工作？',
        evidence: table('固定阈值的留出回测', ['数据段', '样本', 'PASS', '原漏检', '额外复核', '拦截漏检'], [[`前段选阈值 ${selected.threshold}`, train.length, pass(train).length, missed(train).length, selected.reviews, selected.caught], ['后段验证', holdout.length, pass(holdout).length, missed(holdout).length, reviewed.length, captured]]) });
    } else {
      const count = pass(train).length;
      const workload = aoi.options.map(o => ({ threshold: o.threshold, reviews: pass(train).filter(r => Number(r.confidence ?? 0) < o.threshold).length }));
      add({ id: 'aoi-holdout', domain: 'quality', title: '现有阈值没有满足复核预算的方案', kind: '规则回测',
        summary: `前 ${train.length} 条样本中，候选阈值 ${workload.map(o => o.threshold).join('/')} 均需复核超过 PASS 的20%；最少也要复核 ${Math.min(...workload.map(o => o.reviews))}/${count} 件。不能声称靠这些阈值低成本消除漏检。`,
        source: '04_AOI视觉检测记录', scope: '前70%按时间排序样本用于选择，后30%没有被用于调参', limitation: '可扩大候选阈值或改进模型后再验证；本次没有选出可行方案，不编造改善率。',
        agentId: 'quality.aoi', question: '为什么现有转人工阈值不满足20%复核预算，应该核实什么？',
        evidence: table('前段阈值预算检查', ['阈值', '额外复核', 'PASS分母', '复核占比'], workload.map(o => [o.threshold, o.reviews, count, pct(o.reviews, count)])) });
    }
  }
  const nc = ncSummary(db);
  if (nc.all.length) {
    const combos = group(nc.all, r => `${r.process} / ${r.defect}`, r => r.defectQty);
    const total = sum(nc.all.map(r => r.defectQty));
    add({ id: 'quality-pareto', domain: 'quality', title: '工序与不良现象交叉定位', kind: '历史观察',
      summary: `前三个“工序×现象”组合记录不良 ${sum(combos.slice(0, 3).map(p => p[1]))} 件，占记录不良数 ${pct(sum(combos.slice(0, 3).map(p => p[1])), total)}；未开8D ${nc.without8d.length} 单，其中致命 ${nc.fatalWithout8d.length} 单。`,
      source: '10_不良记录与8D跟踪', scope: `${nc.all.length} 张不良单`, limitation: '同一工单可有多张不良单，不把各行生产数相加解释为独立总产量；占比仅针对已记录不良数。', agentId: 'quality.defects', question: '按工序和不良现象交叉定位改善重点，再检查致命不良的8D状态。',
      evidence: table('工序×现象 Top 8', ['组合', '记录不良件数', '占记录不良'], combos.slice(0, 8).map(([k, n]) => [k, n, pct(n, total)])) });
    const orders = new Set(nc.all.map(n => n.workOrder));
    const overlaps = aoi.escapes.filter(a => orders.has(a.workOrder));
    add({ id: 'quality-linked-evidence', domain: 'quality', title: 'AOI 与不良单共享工单的复核入口', kind: '历史观察',
      summary: `${aoi.escapes.length} 件 AOI 漏检中 ${overlaps.length} 件能按工单号关联不良台账，涉及 ${new Set(overlaps.map(a => a.workOrder)).size} 张工单。`,
      source: '04_AOI视觉检测记录 ↔ 10_不良记录与8D跟踪（work_order）', scope: '仅工单号精确相等，不按模糊原因标签连接',
      limitation: '共享工单不证明是同一件产品，也不证明漏检造成台账不良；样本缺少逐件追溯ID，需人工联查。', agentId: 'quality.defects', question: 'AOI 漏检和不良台账按工单能关联哪些记录？这些能证明因果吗？',
      evidence: table('共享工单线索', ['工单', '漏检样本数', '对应不良单'], group(overlaps, a => a.workOrder, () => 1).slice(0, 8).map(([id, n]) => [id, n, nc.all.filter(r => r.workOrder === id).map(r => r.id).slice(0, 6).join('、')])) });
  }
  const doe = db.prepare('SELECT * FROM quality_doe WHERE warpage IS NOT NULL AND cycle IS NOT NULL ORDER BY id').all() as Row[];
  if (doe.length) {
    const front = doe.filter(a => !doe.some(b => Number(b.warpage) <= Number(a.warpage) && Number(b.cycle) <= Number(a.cycle) && (Number(b.warpage) < Number(a.warpage) || Number(b.cycle) < Number(a.cycle)))).sort((a, b) => Number(a.warpage) - Number(b.warpage));
    add({ id: 'doe-tradeoff', domain: 'quality', title: '翘曲与节拍的可选折中点', kind: '历史观察',
      summary: `${doe.length} 组有效试验中 ${front.length} 组在“翘曲更小、周期更短”上互不支配；最低翘曲 ${front[0].warpage} mm 对应 ${front[0].cycle} 秒，最快折中点 ${front.at(-1)!.cycle} 秒对应 ${front.at(-1)!.warpage} mm。`,
      source: '08_注塑工艺DOE', scope: '仅比较有翘曲和周期的已有试验点', limitation: '不是未试验参数组合的最优保证；还需核实收缩率、材料与过程确认，不能把参数范围任意拼成新配方。', agentId: 'quality.doe', question: '给出翘曲与成型周期的折中方案，哪些真实试验点值得试模？',
      evidence: table('已有试验的 Pareto 折中点', ['试验ID', '翘曲mm', '周期s', '收缩率%', '料温', '模温', '保压'], front.map(r => [String(r.id), Number(r.warpage), Number(r.cycle), Number(r.shrinkage), Number(r.melt_temp), Number(r.mold_temp), Number(r.hold_pressure)])) });
  }
  const agv = agvSummary(db);
  if (agv.valid) {
    const vehicles = [...agv.byAgv].sort((a, b) => b.timeouts - a.timeouts);
    const top = vehicles[0];
    const valid = (db.prepare('SELECT * FROM logistics_agv_tasks WHERE origin != dest').all() as Row[]);
    const waits = sum(valid.map(r => Number(r.wait_s ?? 0))), duration = sum(valid.map(r => Number(r.duration_s ?? 0)));
    add({ id: 'agv-wait', domain: 'logistics', title: '配送时间有多少消耗在等待', kind: '历史观察',
      summary: `${agv.valid} 单有效配送累计等待 ${round(waits / 3600, 2)} 小时，占记录耗时 ${pct(waits, duration)}；${top.key} 贡献 ${top.timeouts}/${agv.timeouts} 单超时。`,
      source: '12_AGV调度任务', scope: `${agv.window}；${agv.tasks} 单中剔除 ${agv.invalid.length} 单同起终点`,
      limitation: '等待与超时的关联不能证明拥堵是唯一原因；按时率与制度中的“自动执行率”不是同一指标。', agentId: 'logistics.agv', question: 'AGV 等待负担和超时集中在哪些车辆、线路？',
      evidence: table('车辆超时贡献', ['车辆', '有效任务', '超时单', '占全部超时', '平均等待秒'], vehicles.map(v => [v.key, v.tasks, v.timeouts, pct(v.timeouts, agv.timeouts), v.wait])) });
    add({ id: 'agv-ceiling', domain: 'logistics', title: '只治理最差车辆够不够', kind: '情景估算',
      summary: `保持 ${agv.valid} 单分母不变，若 ${top.key} 的 ${top.timeouts} 单超时全部消除，按时率理论上限 ${pct(agv.valid - agv.timeouts + top.timeouts, agv.valid)}，当前 ${pct(agv.valid - agv.timeouts, agv.valid)}。`,
      source: '12_AGV调度任务', scope: '固定任务集合，单车全部消除超时的极乐观情景', limitation: '不是实际改善或移除车辆后的指标；没有重新调度仿真，未验证电量、容量和新瓶颈。', agentId: 'logistics.agv', question: `只解决 ${top.key} 的超时能改善多少，其他车辆还需做什么？`,
      evidence: table('单车治理上限', ['车辆', '假设消除超时单', '固定分母下按时率上限'], vehicles.map(v => [v.key, v.timeouts, pct(agv.valid - agv.timeouts + v.timeouts, agv.valid)])) });
  }
  const stocks = db.prepare('SELECT * FROM supply_materials').all() as Row[];
  const stale = stocks.filter(r => Number(r.stale_days) >= 90 && Number(r.on_hand) > 0);
  if (stocks.length) {
    const value = (r: Row) => Number(r.on_hand) * Number(r.unit_price);
    const low = stocks.filter(r => Number(r.on_hand) < Number(r.safety_stock));
    add({ id: 'inventory-imbalance', domain: 'supply', title: '缺料与呆滞库存并存', kind: '历史观察',
      summary: `${stocks.length} 种物料中 ${low.length} 种低于安全库存，同时 ${stale.length} 种呆滞≥90天，占用账面金额 ${round(sum(stale.map(value)), 0)} 元（占总库存 ${pct(sum(stale.map(value)), sum(stocks.map(value)))}）。`,
      source: '11_仓储库存', scope: '库存数量×素材包单价；90天为本次分析阈值', limitation: '账面金额不等于可回收现金，缺料与呆滞属于不同物料，不能相互抵销；仅有需求历史的物料才能推算覆盖天数。', agentId: 'supply.inventory', question: '哪些物料既要补货、哪些呆滞库存应该优先处理？',
      evidence: table('呆滞占用 Top 8', ['料号', '名称', '呆滞天数', '库存', '金额元'], [...stale].sort((a, b) => value(b) - value(a)).slice(0, 8).map(r => [String(r.code), String(r.name), Number(r.stale_days), Number(r.on_hand), round(value(r), 0)])) });
  }
  const energy = listEnergy(db).filter(r => r.kwh >= 0 && r.output > 0);
  if (energy.length) {
    const rows = [...new Set(energy.map(r => r.workshop))].map(w => {
      const mine = energy.filter(r => r.workshop === w), ordered = mine.map(r => r.kwh / r.output).sort((a, b) => a - b);
      const median = ordered[Math.floor(ordered.length / 2)];
      const anomalies = mine.filter(r => r.kwh / r.output > median * 2);
      return { w, mine, median, anomalies, excess: sum(anomalies.map(r => r.kwh - median * r.output)) };
    });
    add({ id: 'energy-hotspots', domain: 'ehs', title: '高单位能耗时段的核查量', kind: '情景估算',
      summary: `${energy.length} 条正产量记录中 ${sum(rows.map(r => r.anomalies.length))} 条单位能耗超过本车间中位数2倍；若这些时段达到各自中位水平，电量差额为 ${round(sum(rows.map(r => r.excess)), 0)} kWh。`,
      source: '09_能耗与碳排', scope: '按用电量÷产量重算，零产量行不参与单位能耗比较', limitation: '差额是核查上限线索，不是节电承诺；不同产品结构、工序负载和计量异常都可能导致差异。', agentId: 'ehs.energy', question: '高单位能耗时段集中在哪些车间？核查电量有多大？',
      evidence: table('车间异常时段', ['车间', '中位kWh/件', '异常/正产量行', '差额kWh', '示例时段'], rows.map(r => [r.w, round(r.median, 3), `${r.anomalies.length}/${r.mine.length}`, round(r.excess, 0), r.anomalies.slice(0, 3).map(x => `${x.date} ${x.hour}`).join('；')])) });
  }
  const safety = listSafety(db), high = safety.filter(r => !r.falseAlarm && HIGH_RISK.includes(r.type) && OPEN_STATUSES.includes(r.status));
  if (safety.length) {
    const cameras = group(high, r => r.camera, () => 1);
    add({ id: 'safety-focus', domain: 'ehs', title: '高风险未闭环的点位集中度', kind: '历史观察',
      summary: `${high.length} 起未标记误报的高风险未闭环事件中，前两个点位合计 ${sum(cameras.slice(0, 2).map(r => r[1]))} 起，占 ${pct(sum(cameras.slice(0, 2).map(r => r[1])), high.length)}。`,
      source: '16_EHS安全行为识别', scope: `${safety.length} 条记录；高风险=动火、LOTO、叉车超速、穿越警戒线`, limitation: '待复核记录仍需现场确认；置信度不等于违规事实，不推断具体人员责任。', agentId: 'ehs.safety', question: '高风险未闭环优先处理哪些点位和事件？',
      evidence: table('高风险点位与事件', ['点位', '未闭环数', '事件ID'], cameras.map(([c, n]) => [c, n, high.filter(r => r.camera === c).map(r => r.id).join('、')])) });
  }
  return found;
}

export const discoveryAgent: AgentDefinition = {
  id: 'executive.insights', module: 'executive', name: '数据发现助手', datasets: ['official'],
  description: '从平台业务表重算发现、核验量化口径，并把具体发现交给领域助手继续分析',
  instructions: '所有发现都来自本次重算。严格区分历史观察、规则回测和情景估算，必须同时交代范围、分母和限制。不能将历史覆盖说成全部未来故障可预测，或将算法比较说成已经实现的收益。只选最相关的3项在正文说明。',
  starters: ['从官方数据还能发现哪些值得行动的问题？', '核验故障预警、排产和AGV改善数字', 'AOI、8D和注塑参数还有什么发现？', '库存和能耗可以优先改善什么？'],
  context({ db, now, input }) {
    const all = discover(db, now);
    const matches = all.filter(d => new RegExp(d.id.startsWith('equipment') || d.id.startsWith('repair') ? '故障|设备|预警|维修' : d.domain === 'production' ? '排产|延期|OEE|停机' : d.domain === 'quality' ? '品质|AOI|8D|注塑|不良' : d.domain === 'logistics' ? 'AGV|物流|按时|配送' : d.domain === 'supply' ? '库存|供应|物料|呆滞' : '能耗|安全|用电|EHS', 'i').test(input));
    const discoveries = matches.length ? matches : all;
    return { headline: `${discoveries.length} 项可追溯的数据发现`, discoveries,
      blocks: discoveries.map(d => ({ title: `${d.title}（${d.kind}）`, lines: [d.summary, `来源：${d.source}；范围：${d.scope}`, `边界：${d.limitation}`] })),
      facts: discoveries.map(d => `【${d.kind}】${d.summary}`), pending: ['官方素材包属于模拟业务记录；情景收益需真实流程验证，未执行采购、调度或参数变更。'],
      actions: [], artifacts: [],
    };
  },
};
