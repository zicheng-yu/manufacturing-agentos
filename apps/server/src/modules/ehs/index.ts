import type { Level } from '@agentos/shared';
import type { AgentDefinition, DomainModule, SeedCtx } from '../../core/module.ts';
import { syncStateAlerts } from '../../core/state-alerts.ts';
import { addDays, isoDate, percent } from '../../core/util.ts';
import { num, officialTable } from '../../seed/official.ts';
import { energySummary, HIGH_RISK, listSafety, OPEN_STATUSES, safetySummary } from './data.ts';

/** Review backlog that triggers an alert. */
const BACKLOG = 10;
/** Peak-period share above which load shifting is worth a decision. */
const PEAK_SHARE = 0.25;

function seedEhs({ db, dataset }: SeedCtx): void {
  if (dataset !== 'official') return;
  const energy = db.prepare(
    `INSERT INTO ehs_energy (date, hour, workshop, period, price, kwh, air, output, unit_energy, carbon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('09_能耗与碳排')) {
    energy.run(r['日期'], r['小时'], r['车间'], r['峰谷时段'], num(r['电价(元/kWh)']) ?? 0, num(r['用电量(kWh)']) ?? 0, num(r['压缩空气(m³)']) ?? 0, num(r['产量(件)']) ?? 0, num(r['单位产品能耗(kWh/件)']), num(r['碳排(kgCO2e)']) ?? 0);
  }
  const safety = db.prepare(
    `INSERT INTO ehs_events (id, ts, camera, type, confidence, false_alarm, status, closure_hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('16_EHS安全行为识别')) {
    safety.run(r['事件编号'], r['抓拍时间'], r['摄像头点位'], r['违规类型'], num(r['置信度']) ?? 0, r['是否误报'] === '是' ? 1 : 0, r['处置状态'], num(r['闭环时长(小时)']));
  }
}

const energyAgent: AgentDefinition = {
  id: 'ehs.energy',
  module: 'ehs',
  name: '能耗优化助手',
  description: '按车间与峰平谷时段分析用电、电费和碳排，找出异常时段并估算错峰收益',
  instructions: '你负责能耗与碳排。金额、电量与碳排只用给出的统计；错峰收益是按 20% 峰时电量转谷时的估算，需注明前提。',
  starters: ['哪个车间最耗电？', '错峰用电能省多少钱', '本月碳排多少'],
  context({ db }) {
    const e = energySummary(db);
    const worst = [...e.byWorkshop].sort((a, b) => b.unitEnergy - a.unitEnergy)[0];
    return {
      headline: `本期用电 ${e.kwh} kWh、电费约 ${Math.round(e.cost / 10000)} 万元，峰时占比 ${percent(e.peakShare, 1)}`,
      blocks: [
        { title: '分时电价', lines: [Object.entries(e.prices).map(([p, v]) => `${p} ${v} 元/kWh`).join('；')] },
        { title: '分车间', lines: e.byWorkshop.map((w) => `${w.workshop}：${w.kwh} kWh，单位产品 ${w.unitEnergy} kWh/件，峰时占比 ${percent(w.peakShare, 1)}，电费 ${w.cost} 元`) },
        {
          title: '单位能耗异常时段（超过本车间中位数 2 倍）',
          lines: e.anomalies.length ? e.anomalies.slice(0, 8).map((a) => `${a.date} ${a.hour} ${a.workshop}：${a.unitEnergy} kWh/件，产量 ${a.output} 件`) : ['无'],
        },
        { title: '错峰估算', lines: [`若 20% 峰时电量移到谷时，约节省 ${e.shiftSaving} 元/期`] },
      ],
      facts: [`本期碳排 ${e.carbonTons} 吨 CO2e`, `峰时用电占比 ${percent(e.peakShare, 1)}`, ...(worst ? [`${worst.workshop} 单位产品能耗最高（${worst.unitEnergy} kWh/件）`] : [])],
      pending: ['错峰需核实哪些工序可移班，以及夜班人员与噪声限制'],
      suggestions: [`把可移班的高耗能工序排到谷时段，预计节省约 ${e.shiftSaving} 元/期`, '对单位能耗异常时段排查空转与计量异常'],
      artifacts: [
        {
          kind: 'table',
          title: '车间能耗',
          columns: ['车间', '用电(kWh)', '产量(件)', '单位能耗(kWh/件)', '峰时占比', '电费(元)'],
          rows: e.byWorkshop.map((w) => [w.workshop, w.kwh, w.output, w.unitEnergy, percent(w.peakShare, 1), w.cost]),
        },
      ],
    };
  },
};

const safetyAgent: AgentDefinition = {
  id: 'ehs.safety',
  module: 'ehs',
  name: 'EHS 安全助手',
  description: '汇总视觉识别的安全违规：高风险未闭环、待复核积压、误报率与高发点位',
  instructions: '你负责 EHS 安全行为。高风险违规（动火、LOTO、叉车超速、穿越警戒线）优先；误报率按识别结果统计；不要推断具体责任人。',
  starters: ['有哪些高风险违规还没闭环？', '待复核的有多少', '哪个点位违规最多'],
  context({ db, now }) {
    const s = safetySummary(db);
    const open = [...s.openHighRisk].sort((x, y) => y.ts.localeCompare(x.ts));
    const toReview = open.filter((e) => e.status === '待复核');
    const toFix = open.filter((e) => e.status !== '待复核');
    const hotspots = [...new Set(toFix.map((e) => e.camera))].slice(0, 3);
    return {
      headline: `${open.length} 起高风险违规未闭环：${toReview.length} 起待复核，${toFix.length} 起已确认、整改未闭环`,
      blocks: [
        { title: '状态口径', lines: ['未闭环 = 「待复核」（识别后尚未人工确认）+「已确认整改」（确认是违规、整改尚未闭环）；「已闭环」「已申诉撤销」和误报不计入'] },
        { title: '高风险未闭环（按类型）', lines: s.byType.filter((t) => HIGH_RISK.includes(t.type)).map((t) => `${t.type}：未闭环 ${t.open} 起（共 ${t.count} 起）`) },
        { title: `高风险未闭环（最近 ${Math.min(10, open.length)} 条，全部 ${open.length} 条见表格）`, lines: open.length ? open.slice(0, 10).map((e) => `${e.id} ${e.ts} ${e.camera} ${e.type}（${e.status}）`) : ['无'] },
        { title: '高发点位', lines: s.byCamera.slice(0, 5).map((c) => `${c.camera}：${c.count} 起`) },
        { title: '识别质量', lines: [`共 ${s.total} 条识别，误报率 ${percent(s.falseAlarmRate, 1)}；全部类型待复核 ${s.pendingReview.length} 条（其中高风险 ${toReview.length} 条）`] },
        { title: '依据', lines: ['官方素材包的四份制度中没有安全生产专章；动火、LOTO 的停工与闭环时限按公司 EHS 制度核定'] },
      ],
      facts: [`高风险违规未闭环 ${open.length} 起：待复核 ${toReview.length}，已确认、整改未闭环 ${toFix.length}`, `全部类型待复核 ${s.pendingReview.length} 条`, `误报率 ${percent(s.falseAlarmRate, 1)}`],
      pending: ['待复核事件需安环人员现场或回放确认', '闭环时限的制度依据待核（素材包无安全生产制度）'],
      suggestions: ['动火、LOTO 类违规所在作业立即停工整改，其余高风险违规当班纠正', `对 ${hotspots.join('、') || '高发点位'} 加强现场巡查与班前安全交底`],
      actions: [
        ...(toReview.length ? [{ title: `复核 ${toReview.length} 起高风险待复核违规（${toReview.slice(0, 3).map((e) => e.id).join('、')} 等）`, owner: '安环经理', due: isoDate(addDays(now, 1)) }] : []),
        ...(toFix.length ? [{ title: `${toFix.length} 起已确认高风险违规完成整改并回传证据（重点 ${hotspots.join('、')}）`, owner: '车间主任，安环经理验收', due: isoDate(addDays(now, 2)) }] : []),
      ],
      artifacts: [
        { kind: 'table', title: `高风险违规未闭环（${open.length} 起）`, columns: ['编号', '时间', '点位', '类型', '状态', '置信度'], rows: open.map((e) => [e.id, e.ts, e.camera, e.type, e.status, e.confidence]) },
        { kind: 'table', title: '安全违规（剔除误报）', columns: ['违规类型', '次数', '未闭环', '风险'], rows: s.byType.map((t) => [t.type, t.count, t.open, HIGH_RISK.includes(t.type) ? '高' : '一般']) },
      ],
    };
  },
};

export const ehsModule: DomainModule = {
  id: 'ehs',
  name: '能源安全',
  description: '能耗碳排与 EHS 安全行为：省电、减碳、零事故',
  schema: `
    CREATE TABLE IF NOT EXISTS ehs_energy (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, hour TEXT NOT NULL, workshop TEXT NOT NULL, period TEXT NOT NULL,
      price REAL NOT NULL, kwh REAL NOT NULL, air REAL NOT NULL, output REAL NOT NULL, unit_energy REAL, carbon REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ehs_events (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, camera TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL,
      false_alarm INTEGER NOT NULL, status TEXT NOT NULL, closure_hours REAL
    );`,
  seed: seedEhs,
  agents: [safetyAgent, energyAgent],

  eventTypes: [
    { type: 'high_risk_violation', label: '高风险违规未闭环', severity: 'critical', kind: 'state' },
    { type: 'review_backlog', label: 'EHS 待复核积压', severity: 'warn', kind: 'state' },
    { type: 'energy_peak', label: '峰时用电偏高', severity: 'info', kind: 'state' },
  ],

  signalRules: [
    {
      id: 'ehs-high-risk',
      types: ['high_risk_violation'],
      windowMinutes: 7 * 24 * 60,
      threshold: 1,
      severity: 'critical',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: { decision: '要求高风险违规当班复核、停工整改并追责到班组', impact: '动火、LOTO 等违规可能直接导致人身伤害', owner: '安环经理与车间主任', dueHours: 24, weight: 3 },
    },
    {
      id: 'ehs-backlog',
      types: ['review_backlog'],
      windowMinutes: 7 * 24 * 60,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: { decision: '安排专人清理识别待复核积压', impact: '积压会让真实违规得不到及时处置', owner: '安环经理', dueHours: 48, weight: 1 },
    },
    {
      id: 'ehs-energy-peak',
      types: ['energy_peak'],
      windowMinutes: 30 * 24 * 60,
      threshold: 1,
      severity: 'info',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: { decision: '批准高耗能工序错峰排班试点', impact: '峰时电价高，错峰可直接降低电费', owner: '生产经理与设备动力', dueHours: 168, weight: 1 },
    },
  ],

  beforeEvaluate(deps) {
    const { db } = deps;
    if (listSafety(db).length === 0) return;
    const s = safetySummary(db);
    const types = [...new Set(s.openHighRisk.map((e) => e.type))];
    syncStateAlerts(deps, 'ehs', 'high_risk_violation', s.openHighRisk.length
      ? [{
          key: 'plant',
          title: `${s.openHighRisk.length} 起高风险违规未闭环`,
          summary: `${types.join('、')}；最多的点位 ${s.byCamera[0]?.camera ?? '—'}`,
          payload: { count: s.openHighRisk.length, types },
        }]
      : [], 'EHS 规则');
    syncStateAlerts(deps, 'ehs', 'review_backlog', s.pendingReview.length >= BACKLOG
      ? [{ key: 'plant', title: `EHS 待复核 ${s.pendingReview.length} 条`, summary: `识别待复核 ${s.pendingReview.length} 条，误报率 ${percent(s.falseAlarmRate, 1)}`, payload: { count: s.pendingReview.length } }]
      : [], 'EHS 规则');
    const e = energySummary(db);
    syncStateAlerts(deps, 'ehs', 'energy_peak', e.peakShare > PEAK_SHARE
      ? [{ key: 'plant', title: `峰时用电占比 ${percent(e.peakShare, 1)}`, summary: `本期用电 ${e.kwh} kWh，20% 峰时电量转谷时约省 ${e.shiftSaving} 元`, payload: { peakShare: e.peakShare, saving: e.shiftSaving } }]
      : [], '能耗规则');
  },

  situation({ db, signals }) {
    const s = safetySummary(db);
    const e = energySummary(db);
    const level: Level = signals.some((x) => x.severity === 'critical') ? 'alert' : signals.some((x) => x.severity === 'warn') ? 'watch' : 'normal';
    const top = signals.find((x) => x.severity === 'critical') ?? signals[0];
    return {
      title: '能源与安全',
      level,
      headline: top ? top.title : s.total ? '安全与能耗平稳' : '暂无能源与安全数据',
      metrics: [
        { label: '高风险未闭环', value: s.openHighRisk.length, unit: '起', tone: s.openHighRisk.length ? 'bad' : 'good' },
        { label: '待复核', value: s.pendingReview.length, unit: '条', tone: s.pendingReview.length >= BACKLOG ? 'bad' : 'good' },
        { label: '峰时用电', value: e.kwh ? percent(e.peakShare, 1) : '—', tone: e.peakShare > PEAK_SHARE ? 'bad' : 'neutral' },
      ],
    };
  },

  overview({ db }) {
    const s = safetySummary(db);
    const e = energySummary(db);
    return {
      metrics: [
        { label: '本期用电', value: e.kwh, unit: 'kWh' },
        { label: '本期碳排', value: e.carbonTons, unit: '吨' },
        { label: '安全识别', value: s.total, unit: '条' },
        { label: '误报率', value: percent(s.falseAlarmRate, 1) },
      ],
      tables: [
        {
          kind: 'table',
          title: '安全违规（剔除误报）',
          columns: ['违规类型', '次数', '未闭环', '风险'],
          rows: s.byType.map((t) => [t.type, t.count, t.open, HIGH_RISK.includes(t.type) ? '高' : '一般']),
        },
        {
          kind: 'table',
          title: '待处理安全事件',
          columns: ['编号', '时间', '点位', '类型', '置信度', '状态'],
          rows: listSafety(db).filter((x) => OPEN_STATUSES.includes(x.status) && !x.falseAlarm).map((x) => [x.id, x.ts, x.camera, x.type, x.confidence, x.status]),
        },
        {
          kind: 'table',
          title: '车间能耗',
          columns: ['车间', '用电(kWh)', '单位能耗(kWh/件)', '峰时占比', '电费(元)'],
          rows: e.byWorkshop.map((w) => [w.workshop, w.kwh, w.unitEnergy, percent(w.peakShare, 1), w.cost]),
        },
      ],
    };
  },
};
