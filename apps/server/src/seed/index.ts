import { createAccount } from '../core/auth.ts';
import type { Deps } from '../core/deps.ts';
import { ingestEvent } from '../core/events.ts';
import { evaluateDomain } from '../core/signals.ts';
import { transaction } from '../db.ts';
import { DEMO_ACCOUNTS } from './company.ts';

export function isSeeded(deps: Deps): boolean {
  return Number((deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n) > 0;
}

/** Accounts, module demo data, then historical events so the cockpit starts with context. */
export function seedAll(deps: Deps): void {
  const now = deps.clock();
  transaction(deps.db, () => {
    for (const account of DEMO_ACCOUNTS) createAccount(deps.db, { ...account, password: deps.config.demoPassword }, now);
    for (const module of deps.registry.modules) module.seed?.({ db: deps.db, now, dataset: deps.config.dataset });
  });
  for (const module of deps.registry.modules) {
    for (const event of module.seedEvents?.(now, deps.config.dataset) ?? []) ingestEvent(deps, event);
  }
  for (const module of deps.registry.modules) evaluateDomain(deps, module.id);
}
