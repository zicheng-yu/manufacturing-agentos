// Nonconformance records with 8D status, AOI inspections with manual review, and the moulding DOE from the official
// pack, judged against 《工厂品质管理规定》 (8.1 grading and approval, 11.1 CAPA time limits, 3.2 KPIs).
import type { Level, Metric, Signal, TableArtifact } from '@agentos/shared';
import type { Deps } from '../../core/deps.ts';
import type { AgentDefinition, SituationDraft } from '../../core/module.ts';
import { syncStateAlerts } from '../../core/state-alerts.ts';
import { addDays, isoDate, percent, round } from '../../core/util.ts';
import type { DB, Row } from '../../db.ts';
import { cite, num, officialTable } from '../../seed/official.ts';

/** AOI escape rate above which the model's PASS verdicts need a second look. */
const ESCAPE_LIMIT = 0.05;

export const OFFICIAL_QUALITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS quality_nc (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, work_order TEXT NOT NULL, process TEXT NOT NULL, defect TEXT NOT NULL,
    defect_qty INTEGER NOT NULL, produced INTEGER NOT NULL, severity TEXT NOT NULL, dept TEXT NOT NULL, status_8d TEXT NOT NULL, rate REAL
  );
  CREATE TABLE IF NOT EXISTS quality_aoi (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, work_order TEXT NOT NULL, product TEXT NOT NULL, station TEXT NOT NULL,
    equipment TEXT NOT NULL, defect_type TEXT NOT NULL, confidence REAL, ai TEXT NOT NULL, manual TEXT NOT NULL, area REAL
  );
  CREATE TABLE IF NOT EXISTS quality_doe (
    id TEXT PRIMARY KEY, melt_temp REAL, mold_temp REAL, speed REAL, hold_pressure REAL, cooling REAL,
    warpage REAL, shrinkage REAL, cycle REAL, score REAL
  );`;

export function seedOfficialQuality(db: DB): void {
  const nc = db.prepare(
    `INSERT INTO quality_nc (id, date, work_order, process, defect, defect_qty, produced, severity, dept, status_8d, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('10_不良记录与8D跟踪')) {
    nc.run(r['不良单号'], r['发生日期'], r['工单号'], r['工序'], r['不良现象代码'], num(r['不良数(件)']) ?? 0, num(r['生产数(件)']) ?? 0, r['严重等级'], r['责任部门'], r['8D状态'], num(r['不良率(%)']));
  }
  const aoi = db.prepare(
    `INSERT INTO quality_aoi (ts, work_order, product, station, equipment, defect_type, confidence, ai, manual, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('04_AOI视觉检测记录')) {
    aoi.run(r['检测时间'], r['工单号'], r['产品型号'], r['工位'], r['设备编号'], r['缺陷类型'], num(r['模型置信度']), r['AI判定'], r['人工复核结果'], num(r['缺陷面积(mm²)']));
  }
  const doe = db.prepare(
    `INSERT INTO quality_doe (id, melt_temp, mold_temp, speed, hold_pressure, cooling, warpage, shrinkage, cycle, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('08_注塑工艺DOE')) {
    doe.run(r['试验批次'], num(r['料温(℃)']), num(r['模温(℃)']), num(r['注射速度(mm/s)']), num(r['保压压力(bar)']), num(r['冷却时间(s)']), num(r['翘曲变形(mm)']), num(r['收缩率(%)']), num(r['成型周期(s)']), num(r['综合评分']));
  }
}

export function hasOfficialQuality(db: DB): boolean {
  return Boolean(db.prepare('SELECT 1 FROM quality_nc LIMIT 1').get());
}

interface Nc {
  id: string;
  date: string;
  workOrder: string;
  process: string;
  defect: string;
  defectQty: number;
  produced: number;
  severity: string;
  dept: string;
  status: string;
}

function listNc(db: DB): Nc[] {
  return (db.prepare('SELECT * FROM quality_nc ORDER BY date DESC').all() as Row[]).map((r) => ({
    id: String(r.id),
    date: String(r.date),
    workOrder: String(r.work_order),
    process: String(r.process),
    defect: String(r.defect),
    defectQty: Number(r.defect_qty),
    produced: Number(r.produced),
    severity: String(r.severity),
    dept: String(r.dept),
    status: String(r.status_8d),
  }));
}

const isFatal = (n: Nc) => n.severity.startsWith('A');
const isOpen = (n: Nc) => !n.status.startsWith('D7');

function pareto<T>(items: T[], key: (t: T) => string, weight: (t: T) => number): { key: string; value: number; share: number }[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + weight(item));
  const sum = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
  return [...totals].map(([k, value]) => ({ key: k, value, share: value / sum })).sort((a, b) => b.value - a.value);
}

export function ncSummary(db: DB) {
  const all = listNc(db);
  const produced = all.reduce((s, n) => s + n.produced, 0);
  const defects = all.reduce((s, n) => s + n.defectQty, 0);
  return {
    all,
    rate: produced ? defects / produced : 0,
    fatalWithout8d: all.filter((n) => isFatal(n) && n.status === '未开单'),
    without8d: all.filter((n) => n.status === '未开单'),
    open: all.filter(isOpen),
    byDefect: pareto(all, (n) => n.defect, (n) => n.defectQty),
    byProcess: pareto(all, (n) => n.process, (n) => n.defectQty),
    byDept: pareto(all, (n) => n.dept, (n) => n.defectQty),
    byStatus: pareto(all, (n) => n.status, () => 1),
  };
}

interface Aoi {
  ts: string;
  workOrder: string;
  station: string;
  equipment: string;
  defectType: string;
  confidence: number | null;
  ai: string;
  manual: string;
}

function listAoi(db: DB): Aoi[] {
  return (db.prepare('SELECT * FROM quality_aoi ORDER BY ts').all() as Row[]).map((r) => ({
    ts: String(r.ts),
    workOrder: String(r.work_order),
    station: String(r.station),
    equipment: String(r.equipment),
    defectType: String(r.defect_type),
    confidence: r.confidence === null ? null : Number(r.confidence),
    ai: String(r.ai),
    manual: String(r.manual),
  }));
}

/** AI verdict against the manual review: escapes are defects the AI passed, false calls are good parts it failed. */
export function aoiSummary(db: DB) {
  const all = listAoi(db);
  const escapes = all.filter((a) => a.ai === 'PASS' && a.manual.startsWith('NG'));
  const falseCalls = all.filter((a) => a.ai === 'NG' && a.manual.startsWith('PASS'));
  const trueNg = all.filter((a) => a.manual.startsWith('NG')).length;
  const truePass = all.filter((a) => a.manual.startsWith('PASS')).length;
  // Route PASS verdicts below a confidence threshold to a person: for each candidate, escapes caught vs extra reviews.
  const passes = all.filter((a) => a.ai === 'PASS');
  const options = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((t) => ({
    threshold: t,
    caught: escapes.filter((a) => (a.confidence ?? 0) < t).length,
    reviews: passes.filter((a) => (a.confidence ?? 0) < t).length,
  }));
  // The most escapes caught while extra reviews stay within 20% of PASS volume.
  const affordable = options.filter((o) => o.reviews <= passes.length * 0.2);
  const pick = affordable.sort((a, b) => b.caught - a.caught || a.reviews - b.reviews)[0] ?? null;
  const threshold = escapes.length && pick ? pick.threshold : null;
  const extraReviews = pick?.reviews ?? 0;
  const caught = pick?.caught ?? 0;
  return {
    total: all.length,
    escapes,
    falseCalls,
    escapeRate: trueNg ? escapes.length / trueNg : 0,
    falseCallRate: truePass ? falseCalls.length / truePass : 0,
    byType: pareto(escapes, (a) => (a.defectType === 'OK' ? '模型未识别出缺陷' : a.defectType), () => 1),
    byStation: pareto(escapes, (a) => `${a.station} / ${a.equipment}`, () => 1),
    threshold,
    extraReviews,
    caught,
    options,
    passes: passes.length,
  };
}

const FACTORS = [
  ['melt_temp', '料温(℃)'],
  ['mold_temp', '模温(℃)'],
  ['speed', '注射速度(mm/s)'],
  ['hold_pressure', '保压压力(bar)'],
  ['cooling', '冷却时间(s)'],
] as const;

function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Best trials, the parameter window of the top 10% by score, and each factor's correlation with warpage. */
export function doeSummary(db: DB) {
  const rows = (db.prepare('SELECT * FROM quality_doe WHERE score IS NOT NULL ORDER BY score DESC').all() as Row[]);
  const top = rows.slice(0, Math.max(3, Math.round(rows.length * 0.1)));
  const complete = rows.filter((r) => FACTORS.every(([f]) => r[f] !== null) && r.warpage !== null);
  return {
    trials: rows.length,
    best: rows.slice(0, 5),
    window: FACTORS.map(([f, label]) => {
      const values = top.map((r) => Number(r[f])).filter(Number.isFinite);
      return { factor: label, min: round(Math.min(...values), 1), max: round(Math.max(...values), 1) };
    }),
    effects: FACTORS.map(([f, label]) => ({
      factor: label,
      warpage: round(correlation(complete.map((r) => Number(r[f])), complete.map((r) => Number(r.warpage))), 2),
    })).sort((a, b) => Math.abs(b.warpage) - Math.abs(a.warpage)),
  };
}

const table = (title: string, columns: string[], rows: (string | number)[][], note?: string): TableArtifact => ({ kind: 'table', title, columns, rows, note });

export const defectAgent: AgentDefinition = {
  id: 'quality.defects',
  module: 'quality',
  name: '不良分析助手',
  description: '按不良现象、工序与责任部门做 Pareto，追踪 8D 进度，找出未开单的致命不良',
  instructions: `你负责制程不良分析。先说致命不良与未开 8D 的情况（${cite('QMS-2025-001-8.1')}：致命 / 批量须质委会评审、总经理批准），再给 Pareto 前几项与改善方向；8D 时限按${cite('QMS-2025-001-11.1')}。`,
  starters: ['哪些致命不良还没开 8D？', '不良主要集中在哪些现象和工序', '8D 进度怎么样'],
  context({ db, now }) {
    const s = ncSummary(db);
    if (s.all.length === 0) return { headline: '暂无不良记录', blocks: [] };
    const top = s.byDefect.slice(0, 3);
    return {
      headline: `${s.fatalWithout8d.length} 单致命不良未开 8D；前三项现象占不良数 ${percent(top.reduce((a, b) => a + b.share, 0), 1)}`,
      blocks: [
        { title: '致命（A）不良未开 8D', lines: s.fatalWithout8d.length ? s.fatalWithout8d.map((n) => `${n.id} ${n.date} ${n.workOrder} ${n.process} ${n.defect}，不良 ${n.defectQty}/${n.produced}，责任 ${n.dept}`) : ['无'] },
        { title: '不良现象 Pareto（按不良数）', lines: s.byDefect.map((p) => `${p.key}：${p.value} 件（${percent(p.share, 1)}）`) },
        { title: '工序 Pareto', lines: s.byProcess.slice(0, 5).map((p) => `${p.key}：${p.value} 件（${percent(p.share, 1)}）`) },
        { title: '8D 进度', lines: s.byStatus.map((p) => `${p.key}：${p.value} 单`) },
        { title: '依据', lines: [`${cite('QMS-2025-001-8.1')}：致命 / 批量不良由质委会评审，总经理批准`, `${cite('QMS-2025-001-11.1')}：内部不合格（连续 3 批或重复不良）15 个工作日完成 CAPA`] },
      ],
      facts: [
        `${s.all.length} 单不良，综合不良率 ${percent(s.rate, 2)}`,
        `致命不良 ${s.all.filter(isFatal).length} 单，其中 ${s.fatalWithout8d.length} 单未开 8D`,
        `未开 8D 合计 ${s.without8d.length} 单`,
        `第一大不良现象：${s.byDefect[0].key}（${percent(s.byDefect[0].share, 1)}）`,
      ],
      pending: ['未开 8D 的原因（是否已合并到其他单据）需品质部核实'],
      suggestions: [`本周内为 ${s.fatalWithout8d.length} 单致命不良全部立项 8D，并提交质委会评审`, `针对「${s.byDefect[0].key}」和「${s.byProcess[0].key}」工序做专项改善`],
      actions: s.fatalWithout8d.length ? [{ title: `为 ${s.fatalWithout8d.length} 单致命不良立项 8D 并提交质委会`, owner: '品质经理', due: isoDate(addDays(now, 2)) }] : [],
      artifacts: [
        table('致命不良未开 8D', ['不良单', '日期', '工单', '工序', '现象', '不良数', '生产数', '责任部门'], s.fatalWithout8d.map((n) => [n.id, n.date, n.workOrder, n.process, n.defect, n.defectQty, n.produced, n.dept])),
        table('不良现象 Pareto', ['现象', '不良数', '占比'], s.byDefect.map((p) => [p.key, p.value, percent(p.share, 1)])),
      ],
    };
  },
};

export const aoiAgent: AgentDefinition = {
  id: 'quality.aoi',
  module: 'quality',
  name: 'AOI 复核助手',
  description: '用人工复核结果评估 AOI 视觉模型：漏检、过杀，以及把低置信度 PASS 转人工的阈值',
  instructions: '你负责 AOI 视觉检测。漏检（AI 判 PASS、人工判 NG）比过杀更危险，先说漏检；阈值建议是按复核样本估算，上线前需小批量验证。',
  starters: ['AOI 漏检率是多少？', '哪些缺陷最容易漏检', '置信度阈值怎么调'],
  context({ db }) {
    const a = aoiSummary(db);
    if (a.total === 0) return { headline: '暂无 AOI 记录', blocks: [] };
    return {
      headline: `AOI 漏检率 ${percent(a.escapeRate, 1)}（${a.escapes.length} 件），过杀率 ${percent(a.falseCallRate, 1)}`,
      blocks: [
        { title: '模型与人工复核对照', lines: [`${a.total} 次检测：漏检 ${a.escapes.length}（AI PASS / 人工 NG），过杀 ${a.falseCalls.length}（AI NG / 人工 PASS）`] },
        { title: '漏检缺陷类型', lines: a.byType.map((p) => `${p.key}：${p.value} 件`) },
        { title: '漏检工位 / 设备', lines: a.byStation.slice(0, 5).map((p) => `${p.key}：${p.value} 件`) },
        {
          title: '低置信度 PASS 转人工的阈值',
          lines: [
            ...a.options.map((o) => `< ${o.threshold}：拦下 ${o.caught}/${a.escapes.length} 件漏检，增加 ${o.reviews} 次复核（占 PASS ${percent(o.reviews, a.passes)}）`),
            a.threshold === null ? '复核量都超过 PASS 的 20%，建议先改进模型' : `推荐 ${a.threshold}：复核量不超过 PASS 的 20% 时拦下最多`,
          ],
        },
      ],
      facts: [`漏检率 ${percent(a.escapeRate, 1)}，过杀率 ${percent(a.falseCallRate, 1)}`, ...(a.byType[0] ? [`漏检最多的缺陷：${a.byType[0].key}（${a.byType[0].value} 件）`] : [])],
      pending: ['阈值按现有复核样本估算，需小批量试运行验证'],
      suggestions: a.threshold === null ? [`补充漏检样本重新训练 AOI 模型，训练期间对关键工位 PASS 抽检`] : [`低置信度 PASS（< ${a.threshold}）转人工，并补充「${a.byType[0]?.key ?? ''}」样本重新训练`],
      artifacts: [
        table('转人工阈值对比', ['阈值', '拦下漏检', '增加复核', '占 PASS'], a.options.map((o) => [`< ${o.threshold}`, `${o.caught}/${a.escapes.length}`, o.reviews, percent(o.reviews, a.passes)])),
        table('AOI 漏检明细', ['时间', '工单', '工位', '设备', '模型判定缺陷', '置信度'], a.escapes.map((e) => [e.ts, e.workOrder, e.station, e.equipment, e.defectType === 'OK' ? '未识别' : e.defectType, e.confidence ?? '—'])),
      ],
    };
  },
};

export const doeAgent: AgentDefinition = {
  id: 'quality.doe',
  module: 'quality',
  name: '注塑工艺助手',
  description: '从 300 组注塑 DOE 中找最优参数窗口，说明各参数对翘曲的影响',
  instructions: `你负责注塑工艺参数。推荐窗口取综合评分前 10% 试验的参数范围；相关系数只表示方向和强弱，不代表因果；参数变更须按${cite('QMS-2025-001-6.4')}做特殊过程确认。`,
  starters: ['注塑参数怎么设最好？', '哪个参数对翘曲影响最大', '最优几组试验是什么'],
  context({ db }) {
    const d = doeSummary(db);
    if (d.trials === 0) return { headline: '暂无 DOE 数据', blocks: [] };
    return {
      headline: `推荐窗口来自 ${d.trials} 组试验中评分前 10%；对翘曲影响最大的是${d.effects[0].factor}`,
      blocks: [
        { title: '推荐参数窗口（评分前 10%）', lines: d.window.map((w) => `${w.factor}：${w.min}–${w.max}`) },
        { title: '与翘曲变形的相关系数', lines: d.effects.map((e) => `${e.factor}：${e.warpage}（${e.warpage < 0 ? '升高时翘曲减小' : '升高时翘曲增大'}）`) },
        { title: '最优试验', lines: d.best.map((r) => `${r.id}：料温 ${r.melt_temp}，模温 ${r.mold_temp}，速度 ${r.speed}，保压 ${r.hold_pressure}，冷却 ${r.cooling} → 翘曲 ${r.warpage} mm，收缩 ${r.shrinkage}%，周期 ${r.cycle}s，评分 ${r.score}`) },
      ],
      facts: [`最优试验 ${d.best[0].id}：翘曲 ${d.best[0].warpage} mm，评分 ${d.best[0].score}`],
      pending: [`参数变更按${cite('QMS-2025-001-6.4')}做试模确认`],
      suggestions: [`在推荐窗口中心试模 3 批，确认翘曲与周期后固化工艺卡`],
      artifacts: [
        table('推荐参数窗口', ['参数', '下限', '上限', '与翘曲相关系数'], d.window.map((w) => [w.factor, w.min, w.max, d.effects.find((e) => e.factor === w.factor)?.warpage ?? '—'])),
        table('最优试验', ['批次', '料温', '模温', '速度', '保压', '冷却', '翘曲(mm)', '收缩(%)', '周期(s)', '评分'], d.best.map((r) => [String(r.id), Number(r.melt_temp), Number(r.mold_temp), Number(r.speed), Number(r.hold_pressure), Number(r.cooling), Number(r.warpage), Number(r.shrinkage), Number(r.cycle), Number(r.score)])),
      ],
    };
  },
};

export function syncOfficialQuality(deps: Deps): void {
  if (!hasOfficialQuality(deps.db)) return;
  const s = ncSummary(deps.db);
  syncStateAlerts(deps, 'quality', 'fatal_without_8d', s.fatalWithout8d.length
    ? [{
        key: 'plant',
        title: `${s.fatalWithout8d.length} 单致命不良未开 8D`,
        summary: `${s.fatalWithout8d.map((n) => `${n.id} ${n.process} ${n.defect}`).slice(0, 4).join('；')}；按${cite('QMS-2025-001-8.1')}须质委会评审、总经理批准`,
        payload: { ncs: s.fatalWithout8d.map((n) => n.id), workOrders: s.fatalWithout8d.map((n) => n.workOrder), causes: ['品质异常'] },
      }]
    : [], '8D 规则');
  const a = aoiSummary(deps.db);
  syncStateAlerts(deps, 'quality', 'aoi_escape', a.escapeRate > ESCAPE_LIMIT
    ? [{
        key: 'plant',
        title: `AOI 漏检率 ${percent(a.escapeRate, 1)}`,
        summary: `${a.escapes.length} 件不良被模型判为 PASS，最多的是${a.byType[0]?.key ?? '—'}；${a.threshold === null ? '调阈值转人工的复核量都超过 PASS 的 20%，需补样本重新训练模型' : `建议置信度 < ${a.threshold} 的 PASS 转人工`}`,
        payload: { escapes: a.escapes.length, threshold: a.threshold, causes: ['品质异常'] },
      }]
    : [], 'AOI 规则');
}

export function officialSituation(db: DB, signals: Signal[]): SituationDraft {
  const s = ncSummary(db);
  const a = aoiSummary(db);
  const level: Level = signals.some((x) => x.severity === 'critical') ? 'alert' : signals.length ? 'watch' : 'normal';
  const top = signals.find((x) => x.severity === 'critical') ?? signals[0];
  const metrics: Metric[] = [
    { label: '致命未开 8D', value: s.fatalWithout8d.length, unit: '单', tone: s.fatalWithout8d.length ? 'bad' : 'good' },
    { label: '8D 未闭环', value: s.open.length, unit: '单', tone: 'neutral' },
    { label: 'AOI 漏检率', value: percent(a.escapeRate, 1), tone: a.escapeRate > ESCAPE_LIMIT ? 'bad' : 'good' },
  ];
  return { title: '品质', level, headline: top ? top.title : '制程质量平稳', metrics };
}

export function officialTables(db: DB): TableArtifact[] {
  const s = ncSummary(db);
  const a = aoiSummary(db);
  const d = doeSummary(db);
  return [
    table('致命不良未开 8D', ['不良单', '日期', '工单', '工序', '现象', '不良数', '责任部门'], s.fatalWithout8d.map((n) => [n.id, n.date, n.workOrder, n.process, n.defect, n.defectQty, n.dept])),
    table('不良现象 Pareto', ['现象', '不良数', '占比'], s.byDefect.map((p) => [p.key, p.value, percent(p.share, 1)])),
    table('8D 进度', ['状态', '单数'], s.byStatus.map((p) => [p.key, p.value])),
    table('AOI 漏检（AI PASS / 人工 NG）', ['缺陷类型', '件数'], a.byType.map((p) => [p.key, p.value]), `漏检率 ${percent(a.escapeRate, 1)}，过杀率 ${percent(a.falseCallRate, 1)}`),
    table('注塑推荐参数窗口', ['参数', '下限', '上限'], d.window.map((w) => [w.factor, w.min, w.max]), `取 ${d.trials} 组 DOE 评分前 10%`),
  ];
}
