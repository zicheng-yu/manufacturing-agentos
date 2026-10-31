import type { Domain, MemoryRecord, Task } from '@agentos/shared';
import type { DB, Row } from '../db.ts';
import { newId } from './util.ts';

type Scope = Domain | 'executive';

function rowToMemory(row: Row): MemoryRecord {
  return {
    id: String(row.id),
    domain: row.domain as Scope,
    kind: row.kind as MemoryRecord['kind'],
    content: String(row.content),
    source: row.source as MemoryRecord['source'],
    agentId: (row.agent_id as string | null) ?? null,
    turnId: (row.turn_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/** Keep provenance per turn and kind; another conversation must retain its own copy when a turn is deleted. */
export function remember(
  db: DB,
  input: Omit<MemoryRecord, 'id' | 'createdAt'>,
  now: Date,
): MemoryRecord | null {
  const key = input.content.trim().replace(/\s+/g, ' ');
  const existing = db.prepare('SELECT content FROM memory WHERE domain = ? AND kind = ? AND source = ? AND agent_id IS ? AND turn_id IS ?')
    .all(input.domain, input.kind, input.source, input.agentId ?? null, input.turnId ?? null) as Row[];
  // Keep punctuation: 1.2 and 12 are different quantities.
  if (existing.some((r) => String(r.content).trim().replace(/\s+/g, ' ') === key)) return null;
  const id = newId('MEM');
  db.prepare(
    `INSERT INTO memory (id, domain, kind, content, source, agent_id, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.domain, input.kind, input.content, input.source, input.agentId, input.turnId, now.toISOString());
  return rowToMemory(db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as Row);
}

export function listMemory(db: DB, scopes: Scope[], limit = 50): MemoryRecord[] {
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM memory WHERE domain IN (${placeholders}) ORDER BY created_at DESC LIMIT ${Math.min(limit, 500)}`)
    .all(...scopes) as Row[];
  return rows.map(rowToMemory);
}

/** Working memory of one conversation: what its earlier turns established. */
export function listMemoryForTurns(db: DB, turnIds: string[]): MemoryRecord[] {
  if (turnIds.length === 0) return [];
  const placeholders = turnIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM memory WHERE turn_id IN (${placeholders}) ORDER BY created_at, rowid`).all(...turnIds) as Row[];
  // Repeated facts remain stored with their provenance; pass only the latest exact copy to the model.
  const latest = new Map<string, MemoryRecord>();
  for (const row of rows) {
    const item = rowToMemory(row);
    const key = `${item.domain}:${item.kind}:${item.content.trim().replace(/\s+/g, ' ')}`;
    latest.delete(key); latest.set(key, item);
  }
  return [...latest.values()];
}

function rowToTask(row: Row): Task {
  return {
    id: String(row.id),
    domain: row.domain as Scope,
    title: String(row.title),
    owner: (row.owner as string | null) ?? null,
    due: (row.due as string | null) ?? null,
    status: row.status as Task['status'],
    turnId: (row.turn_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export function addTask(
  db: DB,
  input: { domain: Scope; title: string; owner?: string | null; due?: string | null; turnId?: string | null },
  now: Date,
): Task | null {
  const exists = db.prepare(`SELECT id FROM tasks WHERE domain = ? AND title = ? AND status = 'open'`).get(input.domain, input.title) as Row | undefined;
  if (exists) {
    if (input.turnId) db.prepare('INSERT OR IGNORE INTO task_turn_sources (task_id, turn_id) VALUES (?, ?)').run(String(exists.id), input.turnId);
    return null;
  }
  const id = newId('TSK');
  db.prepare(`INSERT INTO tasks (id, domain, title, owner, due, status, turn_id, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).run(
    id,
    input.domain,
    input.title,
    input.owner ?? null,
    input.due ?? null,
    input.turnId ?? null,
    now.toISOString(),
  );
  if (input.turnId) db.prepare('INSERT INTO task_turn_sources (task_id, turn_id) VALUES (?, ?)').run(id, input.turnId);
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row);
}

export function listTasks(db: DB, scopes: Scope[], status: Task['status'] | 'all' = 'open'): Task[] {
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(',');
  const statusSql = status === 'all' ? '' : ` AND status = '${status === 'done' ? 'done' : 'open'}'`;
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE domain IN (${placeholders})${statusSql} ORDER BY created_at DESC LIMIT 100`)
    .all(...scopes) as Row[];
  return rows.map(rowToTask);
}

export function getTask(db: DB, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToTask(row) : null;
}

export function setTaskStatus(db: DB, id: string, status: Task['status']): void {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
}
