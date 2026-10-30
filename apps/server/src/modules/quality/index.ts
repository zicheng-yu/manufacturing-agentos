import type { Level } from '@agentos/shared';
import type { DomainModule } from '../../core/module.ts';
import { addDays, isoDate } from '../../core/util.ts';
import { capaAgent, complaintAgent } from './agents.ts';
import { isOverdue, listCapa, listCases, listComplaints, similarCases } from './data.ts';
import { qualitySeedEvents, seedQuality } from './seed.ts';

export const qualityModule: DomainModule = {
  id: 'quality',
  name: '品质',
  description: '客诉受理、同类案例检索、8D 改善：让质量问题更快处理',
  schema: `
    CREATE TABLE IF NOT EXISTS quality_cases (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, product TEXT NOT NULL, category TEXT NOT NULL, symptom TEXT NOT NULL,
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
    );`,
  seed: seedQuality,
  seedEvents: qualitySeedEvents,
  agents: [complaintAgent, capaAgent],

  eventTypes: [
    { type: 'customer_complaint', label: '客户投诉', severity: 'warn', dedupeFields: ['complaintId'] },
    { type: 'defect_recurrence', label: '同类异常复发', severity: 'critical', dedupeFields: ['complaintId'] },
    { type: 'capa_overdue', label: '8D 整改逾期', severity: 'warn', dedupeFields: ['capaId'] },
  ],

  signalRules: [
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
        decision: '启动 8D 并约谈相关供应商，决定是否追溯在库与在途批次',
        impact: '历史问题复发说明对策未闭环，存在批量客诉与索赔风险',
        owner: '品质经理牵头，供应链 SQE 配合',
        dueHours: 24,
      },
    },
    {
      id: 'quality-complaints',
      types: ['customer_complaint'],
      windowMinutes: 7 * 24 * 60,
      threshold: 3,
      severity: 'warn',
      describe: (events) => ({
        title: `近 7 天客诉 ${events.length} 起`,
        summary: events.map((e) => e.title).join('；'),
      }),
      playbook: {
        decision: '确认客诉处理优先级与对客户的统一口径',
        impact: '客诉集中出现会影响客户评分与后续定点',
        owner: '品质经理',
        dueHours: 24,
      },
    },
    {
      id: 'quality-capa-overdue',
      types: ['capa_overdue'],
      windowMinutes: 14 * 24 * 60,
      threshold: 1,
      severity: 'warn',
      describe: (events) => ({
        title: `8D 整改逾期 ${events.length} 项`,
        summary: events.map((e) => e.summary).join('；'),
      }),
      playbook: {
        decision: '督办逾期整改项，明确新的完成时间',
        impact: '整改逾期会让同类问题继续流出',
        owner: '品质经理',
        dueHours: 48,
      },
    },
  ],

  situation({ db, now, signals }) {
    const today = isoDate(now);
    const open = listComplaints(db).filter((c) => c.status !== '已结案');
    const overdue = listCapa(db).filter((c) => isOverdue(c, today));
    const weekAgo = isoDate(addDays(now, -7));
    const recent = listComplaints(db).filter((c) => c.receivedAt >= weekAgo);
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
        { label: '近 7 天新增', value: recent.length, unit: '起', tone: 'neutral' },
      ],
    };
  },

  overview({ db, now }) {
    const today = isoDate(now);
    const complaints = listComplaints(db);
    const capa = listCapa(db);
    const cases = listCases(db);
    return {
      metrics: [
        { label: '未结客诉', value: complaints.filter((c) => c.status !== '已结案').length, unit: '起' },
        { label: '整改项', value: capa.filter((c) => c.status !== '已完成').length, unit: '项' },
        { label: '8D 逾期', value: capa.filter((c) => isOverdue(c, today)).length, unit: '项' },
        { label: '案例库', value: cases.length, unit: '条' },
      ],
      tables: [
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

  onEvent({ db, now, emit }, event, { created }) {
    if (event.type !== 'customer_complaint' || !created) return;
    const p = event.payload as Record<string, string | undefined>;
    const complaintId = p.complaintId ?? event.id;
    const query = `${p.symptom ?? ''} ${p.category ?? ''}`;
    const match = similarCases(db, query, p.category)[0]?.case ?? null;
    db.prepare(
      `INSERT OR IGNORE INTO quality_complaints (id, customer, product, batch, symptom, category, severity, status, received_at, owner, case_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, '处理中', ?, '品质经理', ?)`,
    ).run(
      complaintId,
      p.customer ?? '未知客户',
      p.product ?? '',
      p.batch ?? '',
      p.symptom ?? event.summary,
      p.category ?? '未分类',
      event.severity === 'critical' ? '严重' : '一般',
      isoDate(now),
      match?.id ?? null,
    );
    if (!match) return;
    emit({
      domain: 'quality',
      type: 'defect_recurrence',
      title: `${complaintId} 与 ${match.id} 同类复发`,
      summary: `${p.customer ?? ''}「${p.symptom ?? ''}」与历史案例 ${match.id}「${match.title}」同类；历史根因：${match.rootCause}；涉及供应商：${match.supplier}`,
      payload: {
        complaintId,
        category: match.category,
        caseId: match.id,
        caseTitle: match.title,
        supplier: match.supplier,
        materialCode: p.materialCode,
      },
      source: { channel: event.source.channel, actor: '案例比对规则' },
      at: now,
    });
  },
};
