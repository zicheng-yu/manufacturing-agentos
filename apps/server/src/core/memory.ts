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

/** Adds a record unless the same content already exists in that scope. */
export function remember(
  db: DB,
  input: Omit<MemoryRecord, 'id' | 'createdAt'>,
  now: Date,
): MemoryRecord | null {
  const exists = db.prepare('SELECT 1 FROM memory WHERE domain = ? AND content = ?').get(input.domain, input.content);
  if (exists) return null;
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
  const exists = db.prepare(`SELECT 1 FROM tasks WHERE title = ? AND status = 'open'`).get(input.title);
  if (exists) return null;
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
