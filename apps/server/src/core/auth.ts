import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Account, Domain, Role } from '@agentos/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { DB, Row } from '../db.ts';
import type { AppEnv, Deps } from './deps.ts';
import { canSee } from './roles.ts';
import { addMinutes, newId } from './util.ts';

export const SESSION_COOKIE = 'agentos_session';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function rowToAccount(row: Row): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role as Role,
    title: String(row.title),
    active: Number(row.active) === 1,
    lastLoginAt: (row.last_login_at as string | null) ?? null,
  };
}

export function createAccount(
  db: DB,
  input: { username: string; displayName: string; role: Role; title: string; password: string },
  now: Date,
): Account {
  const id = newId('ACC');
  db.prepare(
    `INSERT INTO accounts (id, username, display_name, role, title, password_hash, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, input.username, input.displayName, input.role, input.title, hashPassword(input.password), now.toISOString());
  return rowToAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row);
}

const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MINUTES = 5;

/** Returns a session token, or null when the credentials are wrong. Throws 429 while locked. */
export function login(deps: Deps, username: string, password: string): { token: string; account: Account } | null {
  const now = deps.clock();
  const lock = failures.get(username);
  if (lock && lock.count >= MAX_FAILURES && lock.until > now.getTime()) {
    throw new HTTPException(429, { message: '尝试次数过多，请稍后再试' });
  }
  const row = deps.db.prepare('SELECT * FROM accounts WHERE username = ? AND active = 1').get(username) as Row | undefined;
  if (!row || !verifyPassword(password, String(row.password_hash))) {
    const count = (lock && lock.until > now.getTime() ? lock.count : 0) + 1;
    failures.set(username, { count, until: addMinutes(now, LOCK_MINUTES).getTime() });
    return null;
  }
  failures.delete(username);
  const token = randomBytes(32).toString('base64url');
  deps.db
    .prepare('INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), row.id as string, addMinutes(now, deps.config.sessionHours * 60).toISOString(), now.toISOString());
  deps.db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(now.toISOString(), row.id as string);
  return { token, account: rowToAccount({ ...row, last_login_at: now.toISOString() }) };
}

export function logout(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function accountForToken(deps: Deps, token: string): Account | null {
  const row = deps.db
    .prepare(
      `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1`,
    )
    .get(sha256(token), deps.clock().toISOString()) as Row | undefined;
  return row ? rowToAccount(row) : null;
}

export function sessionMiddleware(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('account', token ? accountForToken(deps, token) : null);
    await next();
  };
}

export function requireAccount(c: Context<AppEnv>): Account {
  const account = c.get('account');
  if (!account) throw new HTTPException(401, { message: '请先登录' });
  return account;
}

export function requireScope(c: Context<AppEnv>, scope: Domain | 'executive'): Account {
  const account = requireAccount(c);
  if (!canSee(account.role, scope)) throw new HTTPException(403, { message: '当前账号无权访问该模块' });
  return account;
}
