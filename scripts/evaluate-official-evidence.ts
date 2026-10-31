// A disposable in-memory copy of exactly the data used by the platform; no model keys, server or live DB.
import { createDeps } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { OfflineProvider } from '../apps/server/src/core/agents/providers.ts';
import { officialFindings } from '../apps/server/src/executive/insights.ts';
import { seedAll } from '../apps/server/src/seed/index.ts';

const date = process.argv[2] ?? '2026-10-30';
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('请传入 YYYY-MM-DD 起算日期');
const now = new Date(`${date}T09:00:00+08:00`);
const deps = createDeps({ ...loadConfig({}), dataset: 'official', dbPath: ':memory:', llm: null, webDist: null }, { clock: () => now, provider: new OfflineProvider() });
try {
  seedAll(deps);
  console.log(JSON.stringify({ source: 'data/official (官方仿真素材)', asOf: now.toISOString(), findings: officialFindings(deps.db, now) }, null, 2));
} finally { deps.db.close(); }
