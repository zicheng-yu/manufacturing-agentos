import { z } from 'zod';
import type { AgentOSEvent } from '@agentos/shared';
import type { EventInput } from '../../core/events.ts';
import { isoDate, normalizeText, shortHash } from '../../core/util.ts';
import { parseJson, type DB, type Row } from '../../db.ts';

export const RequestStatus = z.enum(['待处理', '处理中', '已解决']);
export const ServicePayload = z.object({
  question: z.string().trim().min(1).max(4000),
  questionKey: z.string().min(1),
  accountId: z.string().min(1),
  category: z.string().min(1).max(80),
  history: z.array(z.string().max(4000)).max(6).optional(),
});

// Additive migration: keep existing demo requests and databases intact.
export const REQUEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hr_request_links (
    request_id TEXT PRIMARY KEY REFERENCES hr_requests(id) ON DELETE CASCADE,
    event_id TEXT UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    answer TEXT NOT NULL DEFAULT '', handled_by TEXT, updated_at TEXT
  );
  CREATE TRIGGER IF NOT EXISTS hr_request_event_deleted BEFORE DELETE ON events
  WHEN OLD.domain = 'hr' AND OLD.type = 'service_requested'
  BEGIN
    DELETE FROM hr_requests WHERE id IN (SELECT request_id FROM hr_request_links WHERE event_id = OLD.id);
  END;
  CREATE TRIGGER IF NOT EXISTS hr_request_event_status AFTER UPDATE OF status ON events
  WHEN NEW.domain = 'hr' AND NEW.type = 'service_requested'
  BEGIN
    UPDATE hr_requests SET status = CASE NEW.status WHEN 'resolved' THEN '已解决' WHEN 'acknowledged' THEN '处理中' ELSE '待处理' END
      WHERE id IN (SELECT request_id FROM hr_request_links WHERE event_id = NEW.id);
    UPDATE tasks SET status = CASE NEW.status WHEN 'resolved' THEN 'done' ELSE 'open' END
      WHERE domain = 'hr' AND turn_id = NEW.turn_id;
  END;
`;

export function serviceTaskTitle(question: string, accountId: string): string {
  return `HR 人工答复 [${shortHash(`${accountId}:${normalizeText(question)}`)}]：${normalizeText(question).slice(0, 50)}`;
}

export function serviceRequestEvent(question: string, accountId: string, category = '待分类', history: string[] = []): EventInput {
  const questionKey = normalizeText(question) || question.trim();
  return {
    domain: 'hr', type: 'service_requested',
    title: '员工服务转人工', summary: question,
    payload: { question, questionKey, accountId, category, history: history.slice(-6) },
    source: { channel: 'agent' },
    dedupeKey: `hr:service_requested:${JSON.stringify([accountId, questionKey])}`,
  };
}

export function recordServiceRequest(db: DB, event: AgentOSEvent, now: Date): void {
  const parsed = ServicePayload.safeParse(event.payload);
  if (!parsed.success) return;
  const requestId = event.id.replace(/^EVT-/, 'REQ-');
  db.prepare('INSERT OR IGNORE INTO hr_requests (id, category, question, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(requestId, parsed.data.category, parsed.data.question, '待处理', isoDate(now));
  db.prepare('INSERT OR IGNORE INTO hr_request_links (request_id, event_id) VALUES (?, ?)').run(requestId, event.id);
}

export function listRequests(db: DB, accountId?: string) {
  const sql = 'SELECT r.*, l.event_id, l.answer, l.handled_by, l.updated_at, e.payload_json FROM hr_requests r ' +
    'LEFT JOIN hr_request_links l ON l.request_id = r.id LEFT JOIN events e ON e.id = l.event_id ' +
    (accountId ? "WHERE json_extract(e.payload_json, '$.accountId') = ? " : '') +
    'ORDER BY r.created_at DESC, r.id';
  const rows = db.prepare(sql).all(...(accountId ? [accountId] : [])) as Row[];
  return rows.map((r) => ({
    id: String(r.id), category: String(r.category), question: String(r.question), status: String(r.status),
    createdAt: String(r.created_at), eventId: r.event_id ? String(r.event_id) : null,
    answer: String(r.answer ?? ''), handledBy: r.handled_by ? String(r.handled_by) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
    history: parseJson<{ history?: string[] }>(r.payload_json, {}).history ?? [],
  }));
}
