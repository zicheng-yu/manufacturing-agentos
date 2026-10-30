import type { Account, Domain, StreamMessage } from '@agentos/shared';
import type { Config } from '../config.ts';
import type { DB } from '../db.ts';
import type { LlmProvider } from './agents/providers.ts';
import type { Registry } from './registry.ts';

export interface Deps {
  db: DB;
  config: Config;
  registry: Registry;
  bus: Bus;
  provider: LlmProvider;
  clock: () => Date;
  /** Last published situation per domain, used to publish only real changes. */
  situationCache: Map<Domain, string>;
}

export interface AppEnv {
  Variables: { account: Account | null };
}

type Listener = (message: StreamMessage) => void;

/** In-process pub/sub feeding the SSE stream. */
export class Bus {
  private listeners = new Set<Listener>();

  publish(message: StreamMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
