import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate, round } from '../../core/util.ts';
import {
  compareStrategies,
  overtimePlan,
  equipmentHealth,
  lineOee,
  listRepairs,
  OEE_TARGET,
  plantLosses,
  PRECURSOR_HOURS,
  PRECURSOR_READINGS,
  readings,
  STRATEGY_LABEL,
  VIBRATION_ALARM,
  VIBRATION_WARN,
} from './data.ts';

/** Where each OEE loss reason is handled, so advice points at the right owner. */
const LOSS_ACTIONS: Record<string, string> = {
  品质异常: '交品质部按不良记录做 Pareto 与 8D（品质助手可查）',
  换型调试: '按换型矩阵把相近产品排在一起，并做 SMED 快速换型',
  缺料待料: '与供应链核对低于安全库存的物料与线边配送（AGV 超时）',
  设备故障: '对振动超限设备安排点检，按维修记录做预防性维护',
  计划保养: '把计划保养挪到低负荷班次，避开交期紧的工单',
};

/** Where the pack's hourly history stops and live readings begin, so a burst after a gap is not read as a trend. */
function coverage(db: Parameters<typeof readings>[0], id: string): string | null {
  const series = readings(db, id);
  const at = (ts: string) => Date.parse(ts.replace(' ', 'T'));
  for (let i = series.length - 1; i > 0; i--) {
    const gapHours = (at(series[i].ts) - at(series[i - 1].ts)) / 3_600_000;
    if (gapHours > 24) return `${id} 历史读数截至 ${series[i - 1].ts}，${series[i].ts} 起为现场实时上报，中间约 ${Math.round(gapHours / 24)} 天无读数`;
  }
  return null;
}

export const equipmentAgent: AgentDefinition = {
  id: 'production.equipment',
  module: 'production',
  name: '设备健康助手',
  description: '按传感器时序判断设备健康，找出振动超限，并用维修记录说明预警能提前几天',
  instructions:
    '你负责设备健康与预测性维护。以 ISO 10816 振动分区为准（2.8 mm/s 关注、4.5 mm/s 告警）；说明数据缺失情况；维修记录与振动超限的对应关系只能按给出的数据说，不要推断未记录的故障原因。',
  starters: ['哪些设备振动异常？', 'EQ-CNC-002 最近状态怎么样', '传感器预警能提前几天发现故障？'],
  context({ db, input }) {
    const health = equipmentHealth(db);
    const focus = health.find((h) => input.toUpperCase().includes(h.equipment.id)) ?? null;
    const repairs = listRepairs(db);
    const leads = health.flatMap((h) => h.precursors);
    const avgLead = leads.length ? Math.round(leads.reduce((s, l) => s + l.hoursAhead, 0) / leads.length) : null;
    const flagged = health.filter((h) => h.status !== '正常' || h.alarms.length);
    const gaps = (focus ? [focus] : health).map((h) => coverage(db, h.equipment.id)).filter((g): g is string => g !== null);
    const blocks = [
      ...(gaps.length ? [{ title: '数据范围', lines: gaps }] : []),
      {
        title: '设备健康（30 天小时级读数）',
        lines: health.map(
          (h) =>
            `${h.equipment.id} ${h.equipment.name}（${h.equipment.line}）：基线振动 ${h.baseline} mm/s，最新 ${h.latest?.vibration ?? '—'} mm/s（${h.latest?.ts ?? '—'}），累计超限 ${h.alarms.length} 次，缺失读数 ${h.missing} 条，状态 ${h.status}`,
        ),
      },
      {
        title: `故障前 ${PRECURSOR_HOURS} 小时的振动前兆`,
        lines: leads.length
          ? leads.map((l) => `${l.repair.equipmentId}：首次关注区读数 ${l.firstWarning}，${l.confirmedAt} 满足24小时内3次关注区读数（≥${VIBRATION_WARN} mm/s），触发后 ${l.hoursAhead} 小时发生「${l.repair.symptom}」（原因 ${l.repair.cause}，停机 ${l.repair.downtimeMin} 分钟）`)
          : ['维修记录前没有出现关注区读数'],
      },
    ];
    if (focus) {
      blocks.push({
        title: `${focus.equipment.id} 明细`,
        lines: [
          `关键部件 ${focus.equipment.keyParts}，维保周期 ${focus.equipment.maintenanceCycleDays} 天，投产 ${focus.equipment.commissioned}`,
          ...listRepairs(db).filter((r) => r.equipmentId === focus.equipment.id).map((r) => `${r.id} ${r.occurredAt} ${r.symptom}，原因 ${r.cause}，${r.action}，停机 ${r.downtimeMin} 分钟，费用 ${r.cost} 元`),
          `最近 6 次读数：${readings(db, focus.equipment.id).slice(-6).map((r) => `${r.ts.slice(5)} ${r.vibration ?? '缺失'}`).join('；')}`,
        ],
      });
    }
    return {
      headline: avgLead !== null ? `故障样本回看：${leads.length}/${repairs.length} 次满足预警规则，平均提前 ${avgLead} 小时` : `${flagged.length} 台设备出现过振动超限`,
      blocks,
      facts: [
        ...(avgLead !== null ? [`${repairs.length} 次故障中有 ${leads.length} 次在发生前 ${PRECURSOR_HOURS} 小时内满足24小时3次关注区读数，按第3次读数触发时间算，平均提前 ${avgLead} 小时`] : []),
        ...health.filter((h) => h.missing > 0).slice(0, 3).map((h) => `${h.equipment.id} 缺失 ${h.missing} 条读数`),
      ],
      pending: [
        '前兆与故障的对应基于故障样本回看，未评估无故障时段的误报率，不能代表预测准确率或未来全覆盖；需设备工程师结合维修报告确认因果',
        ...gaps.map((g) => `${g.split(' ')[0]} 的历史与实时读数之间有断档，趋势判断只看实时读数`),
      ],
      suggestions: [
        `24 小时内 ≥${PRECURSOR_READINGS} 次读数进入关注区（≥${VIBRATION_WARN} mm/s）即派点检单，按历史可提前约 ${avgLead ?? '—'} 小时处置；≥${VIBRATION_ALARM} mm/s 立即停机检查`,
        '缺失读数较多的设备先检查传感器与采集网关',
      ],
      artifacts: [
        {
          kind: 'table',
          title: '设备健康',
          columns: ['设备', '名称', '产线', '基线振动', '最新读数', '读数时间', '累计超限', '缺失读数', '上次维修', '状态'],
          rows: health.map((h) => [
            h.equipment.id,
            h.equipment.name,
            h.equipment.line,
            h.baseline,
            h.latest?.vibration ?? '—',
            h.latest?.ts ?? '—',
            h.alarms.length,
            h.missing,
            h.lastRepair ? `${h.lastRepair.occurredAt.slice(0, 10)} ${h.lastRepair.symptom}` : '—',
            h.status,
          ]),
          note: `振动单位 mm/s；ISO 10816：≥${VIBRATION_WARN} 关注，≥${VIBRATION_ALARM} 告警。基线取中位数，避开尖峰与缺失值`,
        },
      ],
    };
  },
};

export const oeeAgent: AgentDefinition = {
  id: 'production.oee',
  module: 'production',
  name: 'OEE 分析助手',
  description: '按产线拆解 OEE（时间 × 性能 × 质量），找出最大损失和对应的责任部门',
  instructions: `你负责 OEE 分析。先说全厂与最差产线，再按损失原因给出改善方向；OEE 目标 ${OEE_TARGET}% 是演示设定，需注明。`,
  starters: ['最近一周哪条线 OEE 最差？', 'OEE 损失主要在哪里', 'L06 为什么 OEE 低'],
  context({ db, input, history }) {
    const lines = lineOee(db);
    const losses = plantLosses(db);
    const plant = round(lines.reduce((s, l) => s + l.oee, 0) / (lines.length || 1), 1);
    const worst = [...lines].sort((a, b) => a.oee - b.oee)[0];
    // A line named now or in the previous question keeps the answer on that line ("为什么？" after "哪条线最差").
    const asked = [input, ...[...history].reverse()].map((text) => lines.find((l) => text.toUpperCase().includes(l.line))).find(Boolean);
    const followUp = history.length > 0 && /为什么|原因|怎么改|如何改|改善|提升/.test(input);
    const focus = asked ?? worst;
    const scoped = Boolean(asked) || followUp;
    const avg = (key: 'availability' | 'performance' | 'quality') => round(lines.reduce((s, l) => s + l[key], 0) / (lines.length || 1), 1);
    const factors = focus
      ? [
          { name: '时间开动率', value: focus.availability, plant: avg('availability'), meaning: '受停机影响（下表的停机分钟）' },
          { name: '性能开动率', value: focus.performance, plant: avg('performance'), meaning: '受降速、小停机、节拍偏差影响' },
          { name: '合格品率', value: focus.quality, plant: avg('quality'), meaning: '受不良与返工影响' },
        ]
      : [];
    const lagging = factors.filter((f) => f.value < f.plant).sort((a, b) => a.value - a.plant - (b.value - b.plant));
    const focusActions = focus ? focus.losses.slice(0, 3).map((l) => `${l.reason}（${Math.round(l.downtimeMin)} 分钟）：${LOSS_ACTIONS[l.reason] ?? '现场核实'}`) : [];
    return {
      headline: scoped && focus
        ? `${focus.line} 近 7 日 OEE ${focus.oee}%：${lagging.length ? `${lagging.map((f) => f.name).join('、')}低于全厂平均` : '三项均不低于全厂平均'}`
        : `近 7 日全厂 OEE ${plant}%，${worst?.line} 最低（${worst?.oee}%）`,
      blocks: [
        {
          title: '各产线近 7 日 OEE',
          lines: lines.map((l) => `${l.line}：OEE ${l.oee}% = 时间 ${l.availability}% × 性能 ${l.performance}% × 质量 ${l.quality}%，最弱项 ${l.weakest}，主要损失 ${l.losses[0]?.reason ?? '—'}`),
        },
        ...(focus
          ? [
              {
                title: `${focus.line} 与全厂平均对比`,
                lines: [
                  ...factors.map((f) => `${f.name}：${focus.line} ${f.value}%，全厂平均 ${f.plant}%（${f.meaning}）`),
                  '停机分钟只影响时间开动率；性能开动率的降速、小停机明细不在素材包的 OEE 日统计中（数据中没有）',
                ],
              },
              {
                title: `${focus.line} 的停机损失（影响时间开动率）`,
                lines: focus.losses.map((l) => `${l.reason}：${Math.round(l.downtimeMin)} 分钟（${l.days} 天）→ ${LOSS_ACTIONS[l.reason] ?? '现场核实'}`),
              },
            ]
          : []),
        ...(scoped ? [] : [{ title: '全厂损失原因（按停机分钟）', lines: losses.map((l) => `${l.reason}：${Math.round(l.downtimeMin)} 分钟，${l.days} 个线日`) }]),
      ],
      facts: scoped && focus
        ? [
            `${focus.line} 近 7 日 OEE ${focus.oee}% = 时间 ${focus.availability}% × 性能 ${focus.performance}% × 质量 ${focus.quality}%`,
            ...lagging.map((f) => `${focus.line} ${f.name} ${f.value}%，低于全厂平均 ${f.plant}%`),
            ...(focus.losses[0] ? [`${focus.line} 最大停机损失「${focus.losses[0].reason}」${Math.round(focus.losses[0].downtimeMin)} 分钟`] : []),
          ]
        : [
            `近 7 日全厂 OEE ${plant}%，低于目标 ${OEE_TARGET}%（演示设定）`,
            ...(losses[0] ? [`全厂最大损失为「${losses[0].reason}」，近 7 日停机 ${Math.round(losses[0].downtimeMin)} 分钟`] : []),
          ],
      pending: scoped && lagging.some((f) => f.name === '性能开动率') ? [`${focus!.line} 性能开动率偏低的原因（降速、小停机、节拍）数据中没有，需设备与工艺现场核实`] : [],
      suggestions: scoped ? focusActions : losses.slice(0, 3).map((l) => `${l.reason}：${LOSS_ACTIONS[l.reason] ?? '现场核实'}`),
      artifacts: [
        {
          kind: 'table',
          title: '产线 OEE（近 7 日）',
          columns: ['产线', 'OEE', '时间开动率', '性能开动率', '合格品率', '最弱项', '主要损失', '损失分钟'],
          rows: lines.map((l) => [l.line, `${l.oee}%`, `${l.availability}%`, `${l.performance}%`, `${l.quality}%`, l.weakest, l.losses[0]?.reason ?? '—', Math.round(l.losses[0]?.downtimeMin ?? 0)]),
          note: `OEE = 时间开动率 × 性能开动率 × 合格品率；目标 ${OEE_TARGET}% 为演示设定`,
        },
      ],
    };
  },
};

export const scheduleAgent: AgentDefinition = {
  id: 'production.schedule',
  module: 'production',
  name: '排产助手',
  description: '按优先级、交期、产线产能与换型时间排产，找出会延期的工单',
  instructions:
    '你负责排产与交期。排产是有限产能的贪心结果（产能按产线日工时、单件工时与近 7 日 OEE 折算），先说哪些工单会延期，再给调线、加班或外协建议；不要承诺未计算的日期。',
  starters: ['哪些工单会延期？', '战略客户的工单能按期交吗', '各产线负荷怎么样'],
  context({ db, now }) {
    const plans = compareStrategies(db, now);
    const { rows, unplaceable, strategy } = plans[0];
    const late = rows.filter((r) => r.late);
    const strategic = rows.filter((r) => r.order.tier === '战略客户');
    const byLine = new Map<string, number>();
    for (const r of rows) byLine.set(r.line, (byLine.get(r.line) ?? 0) + 1);
    const changeoverTotal = rows.reduce((s, r) => s + r.changeoverMin, 0);
    const overtime = late.length ? overtimePlan(db, now) : null;
    const stillLate = overtime?.rows.filter((r) => r.late) ?? [];
    const byTier = (r: (typeof late)[number]) => (r.order.tier === '战略客户' ? 0 : r.order.tier === '重点客户' ? 1 : 2);
    const priorityLate = [...late].sort((a, b) => byTier(a) - byTier(b) || a.slackDays - b.slackDays);
    return {
      headline: late.length ? `${late.length} 张工单按当前产能会延期` : `${rows.length} 张工单都能按期完成`,
      blocks: [
        {
          title: '预计延期工单',
          lines: late.length
            ? late.map((r) => `${r.order.id} ${r.order.product} ${r.order.qty} 件（${r.order.tier}，优先级 ${r.order.priority}）：排 ${r.line}，预计 ${r.finish} 完成，交期 ${r.order.due}，延期 ${-r.slackDays} 天；可选产线 ${r.order.lines.join('/')}`)
            : ['无'],
        },
        { title: '战略客户工单', lines: strategic.map((r) => `${r.order.id}：${r.line}，${r.finish} 完成，交期 ${r.order.due}${r.late ? '（延期）' : ''}`) },
        { title: '产线负荷', lines: [...byLine].sort().map(([line, n]) => `${line}：${n} 张工单`) },
        {
          title: '排序策略对比（取加权延期最小者）',
          lines: plans.map((p) => `${STRATEGY_LABEL[p.strategy]}：延期 ${p.late} 张，加权延期 ${p.weightedLateness} 天${p.strategy === strategy ? '（采用）' : ''}`),
        },
        {
          title: '调线与加班',
          lines: [
            '调线已包含在排产中：每张工单在它的可产线里选最早完工的线',
            ...(overtime
              ? [`加班情景（各线每天排满 24 小时，不超过最大日产能）：延期 ${overtime.late} 张，加权 ${overtime.weightedLateness} 天${stillLate.length ? `；仍延期 ${stillLate.map((r) => `${r.order.id}（${r.order.tier}，${-r.slackDays} 天）`).join('、')}，需外协或与客户协商交期` : '，全部可按期'}`]
              : []),
          ],
        },
        ...(unplaceable.length ? [{ title: '无法排入的工单', lines: unplaceable.map((o) => `${o.id}：可产线 ${o.lines.join('/')} 均无产能数据`) }] : []),
      ],
      facts: [
        `共 ${rows.length} 张工单，采用「${STRATEGY_LABEL[strategy]}」后预计延期 ${late.length} 张，换型合计 ${changeoverTotal} 分钟`,
        ...plans.slice(1).map((p) => `「${STRATEGY_LABEL[p.strategy]}」会延期 ${p.late} 张（加权 ${p.weightedLateness} 天）`),
        ...(overtime ? [`各线排满 24 小时后仍延期 ${overtime.late} 张`] : []),
      ],
      pending: late.length ? ['排产按近 7 日 OEE 折算产能，加班、外协与插单需生产经理确认'] : [],
      suggestions: [
        ...(overtime && overtime.late < late.length ? [`加班可把延期从 ${late.length} 张降到 ${overtime.late} 张，优先给 ${priorityLate.filter((r) => r.order.tier !== '一般客户').map((r) => r.order.id).join('、') || '延期工单'} 所在产线排班`] : []),
        ...(stillLate.length ? [`${stillLate.map((r) => r.order.id).join('、')} 加班后仍延期，评估外协或与客户协商交期`] : []),
      ],
      // Strategic and key customers first, then the longest delays.
      actions: priorityLate.slice(0, 5).map((r) => ({ title: `确认 ${r.order.id}（${r.order.tier}，延期 ${-r.slackDays} 天）的加班 / 外协方案`, owner: r.order.tier === '一般客户' ? '生产经理' : '生产经理与销售', due: isoDate(addDays(now, 1)) })),
      artifacts: [
        {
          kind: 'table',
          title: '排产计划',
          columns: ['工单', '产品', '数量', '客户等级', '优先级', '产线', '开工', '完工', '交期', '余量(天)', '换型(分钟)'],
          rows: rows.map((r) => [r.order.id, r.order.product, r.order.qty, r.order.tier, r.order.priority, r.line, r.start, r.finish, r.order.due, r.slackDays, r.changeoverMin]),
          note: `有限产能排产，比较三种排序后采用「${STRATEGY_LABEL[strategy]}」（加权延期 = 延期天数 × 客户权重，战略 3、重点 2、一般 1）；日产能 = min(最大日产能, 日工时 × 3600 ÷ 单件工时 × 近 7 日 OEE)`,
        },
      ],
    };
  },
};

