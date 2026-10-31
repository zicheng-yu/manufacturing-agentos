import type { Hono } from 'hono';
import { createApp, createDeps } from '../src/app.ts';
import type { Config, Dataset } from '../src/config.ts';
import { OfflineProvider } from '../src/core/agents/providers.ts';
import type { AppEnv, Deps } from '../src/core/deps.ts';
import { openDb } from '../src/db.ts';
import { seedAll } from '../src/seed/index.ts';

export const BRIDGE_TOKEN = 'test-bridge-token';
export const PASSWORD = 'test-password';

export interface TestEnv {
  deps: Deps;
  app: Hono<AppEnv>;
  /** Move the shared clock forward. */
  advance(minutes: number): void;
  login(username: string): Promise<string>;
  get<T = any>(path: string, cookie: string): Promise<{ status: number; body: T }>;
  send<T = any>(method: string, path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  bridge<T = any>(path: string, body: unknown): Promise<{ status: number; body: T }>;
}

/** Tests run on the fictional fixtures unless they ask for the official pack. */
export function setup(start = new Date('2026-10-30T09:00:00+08:00'), dataset: Dataset = 'demo'): TestEnv {
  let now = start;
  const config: Config = {
    dataset,
    port: 0,
    dbPath: ':memory:',
    llm: null,
    bridgeToken: BRIDGE_TOKEN,
    demoPassword: PASSWORD,
    sessionHours: 12,
    webDist: null,
  };
  const deps = createDeps(config, { db: openDb(':memory:'), clock: () => now, provider: new OfflineProvider() });
  seedAll(deps);
  const app = createApp(deps);

  const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  return {
    deps,
    app,
    advance(minutes) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
    async login(username) {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD }),
      });
      if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status}`);
      return res.headers.get('set-cookie')!.split(';')[0];
    },
    async get(path, cookie) {
      const res = await app.request(path, { headers: { Cookie: cookie } });
      return { status: res.status, body: await res.json() };
    },
    send,
    bridge: (path, body) => send('POST', path, body, { 'X-Bridge-Token': BRIDGE_TOKEN }),
  };
}
