import type { Situation } from '@agentos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from '../../../test/helpers.ts';
import { computeSituation, evaluateDomain } from '../../core/signals.ts';
import { ingestEvent, listEvents, setEventStatus } from '../../core/events.ts';
import { qualityDate } from './calendar.ts';
import { listComplaints } from './data.ts';

let env: TestEnv;
beforeEach(() => { env = setup(); });
afterEach(() => { env.deps.db.close(); });

describe('quality live updates and complaint evidence regressions', () => {
  it('ends the minute tick with the newest situation delivered to subscribers', () => {
    const sent: Situation[] = [];
    env.deps.bus.subscribe((message) => {
      if (message.kind === 'situation.updated' && message.situation.domain === 'quality') sent.push(message.situation);
    });
    env.deps.db.prepare('INSERT INTO quality_capa VALUES (?, ?, ?, ?, ?, ?)').run(
      'CAPA-REVIEW', 'CC-2610-05', 'New overdue corrective action', 'Quality owner', qualityDate(env.deps.clock()), '进行中',
    );
    env.deps.db.prepare('INSERT INTO quality_capa VALUES (?, ?, ?, ?, ?, ?)').run(
      'CAPA-REVIEW-2', 'CC-2610-05', 'Second overdue corrective action', 'Quality owner', qualityDate(env.deps.clock()), '进行中',
    );
    env.advance(24 * 60);
    evaluateDomain(env.deps, 'quality');
    expect(sent.at(-1)).toEqual(computeSituation(env.deps, 'quality'));
    expect(sent).toHaveLength(1);
    expect(sent[0].headline).toBe('8D 整改逾期 3 项');
    env.advance(1);
    evaluateDomain(env.deps, 'quality');
    expect(sent).toHaveLength(1);
  });

  it('keeps overdue warnings active after the dashboard resolves the alert without completing the work', () => {
    const overdue = listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).find((event) => event.type === 'capa_overdue')!;
    setEventStatus(env.deps, overdue.id, 'resolved');
    env.advance(1);
    evaluateDomain(env.deps, 'quality');
    expect(listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).some((event) => event.payload.capaId === 'CAPA-031')).toBe(true);
  });

  it('reevaluates recurrence when a later report supplies specific symptom evidence', () => {
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'CC-REVIEW', symptom: '黑屏', category: 'FPC 接触不良' }, source: { channel: 'bridge' } });
    env.advance(11);
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'CC-REVIEW', symptom: 'FPC 金手指发黑氧化', category: 'FPC 接触不良' }, source: { channel: 'bridge' } });
    expect(listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).some((event) => event.type === 'defect_recurrence' && event.payload.complaintId === 'CC-REVIEW')).toBe(true);
    expect(listComplaints(env.deps.db).find((item) => item.id === 'CC-REVIEW')?.symptom).toBe('FPC 金手指发黑氧化');
  });

  it('keeps one complaint and recurrence while preserving receipt date, owner and progress on repeat reports', () => {
    const report = () => ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'CC-REVIEW', customer: 'Test customer', symptom: 'FPC 金手指发黑氧化', category: 'FPC 接触不良' }, source: { channel: 'bridge' } });
    report();
    const first = listComplaints(env.deps.db).find((item) => item.id === 'CC-REVIEW')!;
    env.deps.db.prepare("UPDATE quality_complaints SET owner = 'Assigned owner', status = '验证中' WHERE id = 'CC-REVIEW'").run();
    env.advance(24 * 60);
    report();
    report();
    const rows = listComplaints(env.deps.db).filter((item) => item.id === 'CC-REVIEW');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ receivedAt: first.receivedAt, owner: 'Assigned owner', status: '验证中', caseId: 'QC-2024-017' });
    const events = listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).filter((event) => event.payload.complaintId === 'CC-REVIEW');
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.count === 1)).toBe(true);
  });

  it('clears an obsolete automatic recurrence after a correction without clearing a manual report', () => {
    const report = (symptom: string) => ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'CC-REVIEW', symptom, category: 'FPC 接触不良' }, source: { channel: 'bridge' } });
    report('FPC 金手指发黑氧化');
    const automatic = listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).find((event) => event.type === 'defect_recurrence')!;
    const manual = ingestEvent(env.deps, { domain: 'quality', type: 'defect_recurrence', dedupeKey: 'manual:CC-REVIEW', payload: { complaintId: 'CC-REVIEW', category: 'FPC 接触不良', caseId: 'QC-2024-017' }, source: { channel: 'manual', actor: 'Quality reviewer' } }).event;
    report('不是金手指氧化，是外包装纸箱破损');
    const active = listEvents(env.deps, { domains: ['quality'], status: 'unresolved' });
    expect(active.some((event) => event.id === automatic.id)).toBe(false);
    expect(active.some((event) => event.id === manual.id)).toBe(true);
    expect(listComplaints(env.deps.db).find((item) => item.id === 'CC-REVIEW')?.caseId).toBeNull();
  });

  it('replaces the old recurrence and signal when corrected evidence identifies a different case', () => {
    const report = (symptom: string, category: string) => ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: 'CC-REVIEW', symptom, category }, source: { channel: 'bridge' } });
    report('FPC 金手指发黑氧化', 'FPC 接触不良');
    report('偏光片起泡', '偏光片气泡');
    const active = listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).filter((event) => event.type === 'defect_recurrence');
    expect(active).toHaveLength(1);
    expect(active[0].payload.caseId).toBe('QC-2025-011');
    expect(computeSituation(env.deps, 'quality').headline).toContain('偏光片气泡');
    expect(listComplaints(env.deps.db).find((item) => item.id === 'CC-REVIEW')?.caseId).toBe('QC-2025-011');
  });

  it('does not reopen or overwrite a closed complaint when its source reports it again', () => {
    const original = listComplaints(env.deps.db).find((item) => item.id === 'CC-2609-21')!;
    ingestEvent(env.deps, { domain: 'quality', type: 'customer_complaint', payload: { complaintId: original.id, symptom: 'FPC 金手指发黑氧化', category: 'FPC 接触不良' }, source: { channel: 'bridge' } });
    expect(listComplaints(env.deps.db).find((item) => item.id === original.id)).toEqual(original);
    expect(listEvents(env.deps, { domains: ['quality'], status: 'unresolved' }).some((event) => event.type === 'defect_recurrence' && event.payload.complaintId === original.id)).toBe(false);
  });
});
