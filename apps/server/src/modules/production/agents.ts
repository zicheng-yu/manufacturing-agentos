import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate, round } from '../../core/util.ts';
import {
  equipmentHealth,
  lineOee,
  listRepairs,
  OEE_TARGET,
  plantLosses,
  readings,
  schedule,
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
    const leads = health.flatMap((h) => h.leadDays);
    const avgLead = leads.length ? round(leads.reduce((s, l) => s + l.days, 0) / leads.length, 1) : null;
    const flagged = health.filter((h) => h.status !== '正常' || h.alarms.length);
    const blocks = [
      {
        title: '设备健康（30 天小时级读数）',
        lines: health.map(
          (h) =>
            `${h.equipment.id} ${h.equipment.name}（${h.equipment.line}）：基线振动 ${h.baseline} mm/s，最新 ${h.latest?.vibration ?? '—'} mm/s（${h.latest?.ts ?? '—'}），累计超限 ${h.alarms.length} 次，缺失读数 ${h.missing} 条，状态 ${h.status}`,
        ),
      },
      {
        title: '振动超限与随后的故障',
        lines: leads.length
          ? leads.map((l) => `${l.repair.equipmentId}：超限后 ${l.days} 天发生「${l.repair.symptom}」（${l.repair.occurredAt}，原因 ${l.repair.cause}，停机 ${l.repair.downtimeMin} 分钟）`)
          : ['维修记录前 14 天内没有振动超限'],
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
      headline: avgLead !== null ? `振动超限平均提前 ${avgLead} 天预示了故障` : `${flagged.length} 台设备出现过振动超限`,
      blocks,
      facts: [
        ...(avgLead !== null ? [`${leads.length} 次故障前 14 天内出现过振动超限，平均提前 ${avgLead} 天`] : []),
        ...health.filter((h) => h.missing > 0).slice(0, 3).map((h) => `${h.equipment.id} 缺失 ${h.missing} 条读数`),
      ],
      pending: ['超限与故障的对应基于时间先后，需设备工程师结合维修报告确认因果'],
      suggestions: [
        `振动连续两小时 ≥ ${VIBRATION_ALARM} mm/s 时自动派点检单，≥ ${VIBRATION_WARN} mm/s 进入关注清单`,
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
  context({ db, input }) {
    const lines = lineOee(db);
    const losses = plantLosses(db);
    const plant = round(lines.reduce((s, l) => s + l.oee, 0) / (lines.length || 1), 1);
    const worst = [...lines].sort((a, b) => a.oee - b.oee)[0];
    const focus = lines.find((l) => input.toUpperCase().includes(l.line)) ?? worst;
    return {
      headline: `近 7 日全厂 OEE ${plant}%，${worst?.line} 最低（${worst?.oee}%）`,
      blocks: [
        {
          title: '各产线近 7 日 OEE',
          lines: lines.map((l) => `${l.line}：OEE ${l.oee}% = 时间 ${l.availability}% × 性能 ${l.performance}% × 质量 ${l.quality}%，最弱项 ${l.weakest}，主要损失 ${l.losses[0]?.reason ?? '—'}`),
        },
        { title: '全厂损失原因（按停机分钟）', lines: losses.map((l) => `${l.reason}：${Math.round(l.downtimeMin)} 分钟，${l.days} 个线日`) },
        {
          title: `${focus?.line} 的损失`,
          lines: focus ? focus.losses.map((l) => `${l.reason}：${Math.round(l.downtimeMin)} 分钟（${l.days} 天）→ ${LOSS_ACTIONS[l.reason] ?? '现场核实'}`) : ['无数据'],
        },
      ],
      facts: [
        `近 7 日全厂 OEE ${plant}%，低于目标 ${OEE_TARGET}%（演示设定）`,
        ...(losses[0] ? [`最大损失为「${losses[0].reason}」，累计停机 ${Math.round(losses[0].downtimeMin)} 分钟`] : []),
      ],
      suggestions: losses.slice(0, 3).map((l) => `${l.reason}：${LOSS_ACTIONS[l.reason] ?? '现场核实'}`),
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
    const { rows, unplaceable } = schedule(db, now);
    const late = rows.filter((r) => r.late);
    const strategic = rows.filter((r) => r.order.tier === '战略客户');
    const byLine = new Map<string, number>();
    for (const r of rows) byLine.set(r.line, (byLine.get(r.line) ?? 0) + 1);
    const changeoverTotal = rows.reduce((s, r) => s + r.changeoverMin, 0);
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
        ...(unplaceable.length ? [{ title: '无法排入的工单', lines: unplaceable.map((o) => `${o.id}：可产线 ${o.lines.join('/')} 均无产能数据`) }] : []),
      ],
      facts: [`共 ${rows.length} 张工单，预计延期 ${late.length} 张，换型合计 ${changeoverTotal} 分钟`],
      pending: late.length ? ['排产按近 7 日 OEE 折算产能，加班、外协与插单需生产经理确认'] : [],
      suggestions: late.slice(0, 3).map((r) => `${r.order.id}：评估改排到 ${r.order.lines.filter((l) => l !== r.line).join('/') || '其他产线'} 或加班`),
      actions: late.slice(0, 5).map((r) => ({ title: `确认 ${r.order.id} 延期处置（加班 / 调线 / 外协）`, owner: '生产经理', due: isoDate(addDays(now, 1)) })),
      artifacts: [
        {
          kind: 'table',
          title: '排产计划',
          columns: ['工单', '产品', '数量', '客户等级', '优先级', '产线', '开工', '完工', '交期', '余量(天)', '换型(分钟)'],
          rows: rows.map((r) => [r.order.id, r.order.product, r.order.qty, r.order.tier, r.order.priority, r.line, r.start, r.finish, r.order.due, r.slackDays, r.changeoverMin]),
          note: '贪心有限产能排产：优先级高、交期早的先排；日产能 = min(最大日产能, 日工时 × 3600 ÷ 单件工时 × 近 7 日 OEE)',
        },
      ],
    };
  },
};

