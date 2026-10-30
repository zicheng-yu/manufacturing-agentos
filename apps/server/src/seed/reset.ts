// Recreate the database with fresh demo data: `npm run seed`. Stop the server first.
import { rmSync } from 'node:fs';
import { createDeps } from '../app.ts';
import { loadConfig } from '../config.ts';
import { seedAll } from './index.ts';

const config = loadConfig();
for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
const deps = createDeps(config);
seedAll(deps);
const count = (sql: string) => Number((deps.db.prepare(sql).get() as { n: number }).n);
console.log(
  `演示数据已重置：账号 ${count('SELECT COUNT(*) AS n FROM accounts')} 个，事件 ${count('SELECT COUNT(*) AS n FROM events')} 条，活跃信号 ${count(`SELECT COUNT(*) AS n FROM signals WHERE status = 'active'`)} 条`,
);
deps.db.close();
