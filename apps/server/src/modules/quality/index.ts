import type { Level } from '@agentos/shared';
import type { DomainModule } from '../../core/module.ts';
import { aoiAgent, defectAgent, doeAgent, hasOfficialQuality, OFFICIAL_QUALITY_SCHEMA, officialSituation, officialTables, seedOfficialQuality, syncOfficialQuality } from './official.ts';
import { capaAgent, complaintAgent } from './agents.ts';
import { complaintTrend, isClosedComplaint, isOverdue, listCapa, listCases, listComplaints, similarCases } from './data.ts';
import { qualitySeedEvents, seedQuality } from './seed.ts';
import { qualityDate } from './calendar.ts';
import { qualityRoutes } from './routes.ts';
import { normalizeSymptom } from './symptoms.ts';
import { syncOverdueEvents } from './tracking.ts';
import { parseJson, type Row } from '../../db.ts';

export const qualityModule: DomainModule = {
  id: 'quality',
  name: '品质',
  description: '客诉受理、同类案例检索、8D 改善：让质量问题更快处理',
  schema: `
    CREATE TABLE IF NOT EXISTS quality_cases (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', product TEXT NOT NULL, category TEXT NOT NULL, symptom TEXT NOT NULL,
      root_cause TEXT NOT NULL, countermeasure TEXT NOT NULL, supplier TEXT NOT NULL, closed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quality_complaints (
      id TEXT PRIMARY KEY, customer TEXT NOT NULL, product TEXT NOT NULL, batch TEXT NOT NULL, symptom TEXT NOT NULL,
      category TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL,
      owner TEXT NOT NULL, case_id TEXT
    );
    CREATE TABLE IF NOT EXISTS quality_capa (
      id TEXT PRIMARY KEY, complaint_id TEXT NOT NULL, title TEXT NOT NULL, owner TEXT NOT NULL,
      due TEXT NOT NULL, status TEXT NOT NULL
    );
    ${OFFICIAL_QUALITY_SCHEMA}`,
  // The official pack has nonconformance, AOI and DOE data but no customer complaints, so the fictional complaint
  // library is only loaded with the demo fixtures; complaints reported through the bridge still work.
  seed(ctx) {
    if (ctx.dataset === 'official') seedOfficialQuality(ctx.db);
    else seedQuality(ctx);
  },
  seedEvents: (now, dataset) => (dataset === 'official' ? [] : qualitySeedEvents(now)),
  agents: [defectAgent, aoiAgent, doeAgent, complaintAgent, capaAgent],
  routes: qualityRoutes,
  beforeEvaluate(deps) {
    syncOverdueEvents(deps);
    syncOfficialQuality(deps);
  },

  eventTypes: [
    { type: 'fatal_without_8d', label: '致命不良未开 8D', severity: 'critical', kind: 'state' },
    { type: 'aoi_escape', label: 'AOI 漏检偏高', severity: 'warn', kind: 'state' },
    { type: 'customer_complaint', label: '客户投诉', severity: 'warn', kind: 'state', dedupeFields: ['complaintId'] },
    { type: 'defect_recurrence', label: '同类异常复发', severity: 'critical', kind: 'state', dedupeFields: ['complaintId'] },
    { type: 'capa_overdue', label: '8D 整改逾期', severity: 'warn', kind: 'state', dedupeFields: ['capaId'] },
  ],

  signalRules: [
    {
      id: 'quality-fatal-8d',
      types: ['fatal_without_8d'],
      windowMinutes: 30 * 24 * 60,
      threshold: 1,
      severity: 'critical',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: { decision: '责成致命不良全部立项 8D，并召开质委会评审', impact: '致命不良未闭环，存在批量流出与客户索赔风险', owner: '品质经理，总经理批准', dueHours: 48, weight: 3 },
    },
    {
      id: 'quality-aoi-escape',
      types: ['aoi_escape'],
      windowMinutes: 30 * 24 * 60,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({ title: events.at(-1)!.title, summary: events.at(-1)!.summary }),
      playbook: { decision: '批准 AOI 低置信度 PASS 转人工复核，并补充样本重训', impact: '视觉模型漏检会让不良流出到下工序或客户', owner: '品质经理与 IT', dueHours: 72, weight: 2 },
    },
    {
      id: 'quality-recurrence',
      types: ['defect_recurrence'],
      windowMinutes: 30 * 24 * 60,
      threshold: 1,
      severity: 'critical',
      groupBy: (e) => String(e.payload.category ?? '') || null,
      describe: (events, group) => ({
        title: `同类异常复发：${group}`,
        summary: events.at(-1)!.summary,
      }),
      playbook: {
        decision: '启动 8D 核实根因及供应商关联，决定是否追溯在库与在途批次',
        impact: '同类症状可能复发，需验证根因与历史对策执行，评估批量客诉与索赔风险',
        owner: '品质经理牵头，供应链 SQE 配合',
        dueHours: 24,
        weight: 3,
      },
    },
    {
      id: 'quality-complaints',
      types: ['customer_complaint'],
      windowMinutes: 7 * 24 * 60,
      threshold: 3,
      severity: 'warn',
      describe: (events) => ({
        title: `近 7 天有更新的客诉 ${new Set(events.map((e) => e.payload.complaintId ?? e.id)).size} 起`,
        summary: events.map((e) => e.title).join('；'),
      }),
      playbook: {
        decision: '确认客诉处理优先级与对客户的统一口径',
        impact: '客诉集中出现会影响客户评分与后续定点',
        owner: '品质经理',
        dueHours: 24,
        weight: 2,
      },
    },
    {
      id: 'quality-capa-overdue',
      types: ['capa_overdue'],
      windowMinutes: 14 * 24 * 60,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({
        title: `8D 整改逾期 ${new Set(events.map((e) => e.payload.capaId ?? e.id)).size} 项`,
        summary: events.map((e) => e.summary).join('；'),
      }),
      playbook: {
        decision: '督办逾期整改项，明确新的完成时间',
        impact: '整改逾期会让同类问题继续流出',
        owner: '品质经理',
        dueHours: 48,
        weight: 1,
      },
    },
  ],

  situation({ db, now, signals }) {
    if (hasOfficialQuality(db)) return officialSituation(db, signals);
    const today = qualityDate(now);
    const open = listComplaints(db).filter((c) => !isClosedComplaint(c) && c.receivedAt <= today);
    const overdue = listCapa(db).filter((c) => isOverdue(c, today));
    const trend = complaintTrend(db, today);
    const level: Level = signals.some((s) => s.severity === 'critical')
      ? 'alert'
      : signals.length > 0 || overdue.length > 0
        ? 'watch'
        : 'normal';
    const top = signals.find((s) => s.severity === 'critical') ?? signals[0];
    return {
      title: '品质',
      level,
      headline: top ? top.title : open.length ? `${open.length} 起客诉处理中` : '无未结客诉',
      metrics: [
        { label: '未结客诉', value: open.length, unit: '起', tone: open.length ? 'bad' : 'good' },
        { label: '8D 逾期', value: overdue.length, unit: '项', tone: overdue.length ? 'bad' : 'good' },
        { label: '近 7 天新增', value: trend.current, unit: '起', tone: 'neutral' },
        { label: '较前 7 天增减', value: trend.delta, unit: '起', tone: trend.delta > 0 ? 'bad' : trend.delta < 0 ? 'good' : 'neutral' },
      ],
    };
  },

  overview({ db, now }) {
    if (hasOfficialQuality(db)) {
      const ncs = db.prepare('SELECT COUNT(*) AS n FROM quality_nc').get() as { n: number };
      const aoi = db.prepare('SELECT COUNT(*) AS n FROM quality_aoi').get() as { n: number };
      return {
        metrics: [
          { label: '不良记录', value: Number(ncs.n), unit: '单' },
          { label: 'AOI 检测', value: Number(aoi.n), unit: '次' },
          { label: '客诉', value: listComplaints(db).length, unit: '起' },
          { label: 'DOE 试验', value: Number((db.prepare('SELECT COUNT(*) AS n FROM quality_doe').get() as { n: number }).n), unit: '组' },
        ],
        tables: officialTables(db),
      };
    }
    const today = qualityDate(now);
    const complaints = listComplaints(db);
    const capa = listCapa(db);
    const cases = listCases(db);
    const trend = complaintTrend(db, today);
    return {
      metrics: [
        { label: '未结客诉', value: complaints.filter((c) => !isClosedComplaint(c) && c.receivedAt <= today).length, unit: '起' },
        { label: '整改项', value: capa.filter((c) => !['已完成', '已取消'].includes(c.status)).length, unit: '项' },
        { label: '8D 逾期', value: capa.filter((c) => isOverdue(c, today)).length, unit: '项' },
        { label: '案例库', value: cases.length, unit: '条' },
        { label: '近 7 天新增', value: trend.current, unit: '起' },
      ],
      tables: [
        { kind: 'table', title: '近 7 天客诉趋势', columns: ['日期', '新增客诉'], rows: trend.daily.map((d) => [d.day, d.count]), note: `中国标准时间，今天及前6天；共 ${trend.current} 起，前7天 ${trend.previous} 起，增减 ${trend.delta} 起。按客诉编号计数，排除未来日期与已取消记录；不把未跟踪的成本或关闭日期当作已有指标。` },
        {
          kind: 'table',
          title: '客诉',
          columns: ['编号', '客户', '产品', '批次', '现象', '类别', '状态', '收到日期', '关联案例'],
          rows: complaints.map((c) => [c.id, c.customer, c.product, c.batch, c.symptom, c.category, c.status, c.receivedAt, c.caseId ?? '—']),
        },
        {
          kind: 'table',
          title: '8D 整改项',
          columns: ['编号', '客诉', '整改内容', '负责人', '完成期限', '状态'],
          rows: capa.map((c) => [c.id, c.complaintId, c.title, c.owner, c.due, isOverdue(c, today) ? '已逾期' : c.status]),
        },
        {
          kind: 'table',
          title: '品质案例库',
          columns: ['编号', '标题', '类别', '根因', '对策', '涉及供应商'],
          rows: cases.map((c) => [c.id, c.title, c.category, c.rootCause, c.countermeasure, c.supplier]),
        },
      ],
    };
  },

  onEvent({ db, now, emit, resolve }, event) {
    if (event.type !== 'customer_complaint') return;
    const p = event.payload as Record<string, string | undefined>;
    const complaintId = p.complaintId ?? event.id;
    const existing = listComplaints(db).find((c) => c.id === complaintId);
    // A repeated report must not reopen or rewrite a complaint already closed by the business.
    if (existing && isClosedComplaint(existing)) return;
    const symptom = p.symptom ?? (event.summary || existing?.symptom || '');
    const category = p.category ?? existing?.category ?? '未分类';
    const query = symptom.replace(/\bQC-[A-Z0-9-]+\b/gi, '');
    const match = similarCases(db, query, category).find((m) => m.specific &&
      (category === '未分类' || normalizeSymptom(category) === normalizeSymptom(m.case.category)))?.case ?? null;
    db.prepare(
      `INSERT INTO quality_complaints (id, customer, product, batch, symptom, category, severity, status, received_at, owner, case_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, '处理中', ?, '品质经理', ?)
       ON CONFLICT(id) DO UPDATE SET customer = excluded.customer, product = excluded.product,
         batch = excluded.batch, symptom = excluded.symptom, category = excluded.category,
         severity = excluded.severity, case_id = excluded.case_id`,
    ).run(
      complaintId,
      p.customer ?? existing?.customer ?? '未知客户',
      p.product ?? existing?.product ?? '',
      p.batch ?? existing?.batch ?? '',
      symptom,
      category,
      event.severity === 'critical' ? '严重' : existing?.severity ?? '一般',
      qualityDate(now),
      match?.id ?? null,
    );
    // Corrected evidence can invalidate a previous automatic match; keep manual reports intact.
    const recurrences = db.prepare("SELECT id, payload_json, source_json FROM events WHERE domain = 'quality' AND type = 'defect_recurrence' AND status != 'resolved'").all() as Row[];
    for (const row of recurrences) {
      const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
      const source = parseJson<Record<string, unknown>>(row.source_json, {});
      if (payload.complaintId === complaintId && source.actor === '案例比对规则' && payload.caseId !== match?.id) resolve(String(row.id));
    }
    if (!match) return;
    emit({
      domain: 'quality',
      type: 'defect_recurrence',
      title: `${complaintId} 与 ${match.id} 疑似同类复发`,
      summary: `${p.customer ?? existing?.customer ?? ''}「${symptom}」与历史案例 ${match.id}「${match.title}」症状相似；历史根因：${match.rootCause}；历史案例涉及供应商：${match.supplier}；本次根因与责任归属待失效分析确认`,
      payload: {
        complaintId,
        category: match.category,
        caseId: match.id,
        caseTitle: match.title,
        rootCause: match.rootCause,
        supplier: p.supplier ?? match.supplier,
        supplierId: p.supplierId,
        historicalSupplier: match.supplier,
        rootCauseStatus: 'historical_only_pending_verification',
        materialCode: p.materialCode,
      },
      source: { channel: event.source.channel, actor: '案例比对规则' },
      at: now,
    });
  },
};
