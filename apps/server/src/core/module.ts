import type {
  Account,
  ActionItem,
  AgentOSEvent,
  Artifact,
  Domain,
  Level,
  Metric,
  PolicyResponse,
  Role,
  Severity,
  Signal,
  TableArtifact,
} from '@agentos/shared';
import type { Hono } from 'hono';
import type { Dataset } from '../config.ts';
import type { DB } from '../db.ts';
import type { AppEnv, Deps } from './deps.ts';
import type { EventInput } from './events.ts';

/**
 * The contract every domain module implements. A module owns its folder under src/modules/<id>/,
 * its own tables (prefixed with the module id) and its demo data. Core code never reads module tables.
 */
export interface DomainModule {
  id: Domain;
  name: string;
  description: string;
  /** CREATE TABLE IF NOT EXISTS statements; table names must start with `<id>_`. */
  schema?: string;
  /** Add columns an existing database lacks (see ensureColumns). Runs after schema on every start. */
  migrate?(db: DB): void;
  seed?(ctx: SeedCtx): void;
  /** Historical events ingested after seeding, so the demo starts with some context. */
  seedEvents?(now: Date, dataset: Dataset): EventInput[];
  agents: AgentDefinition[];
  eventTypes: EventTypeDefinition[];
  signalRules: SignalRule[];
  /** Sync business-state alerts before evaluation. Events emitted here are evaluated together afterward. */
  beforeEvaluate?(deps: Deps): void;
  /** The executive cockpit card for this module. */
  situation(ctx: ModuleCtx & { signals: Signal[] }): SituationDraft;
  /** Metrics and tables shown on the module page. */
  overview(ctx: ModuleCtx): { metrics: Metric[]; tables: TableArtifact[] };
  /** Keep module tables in sync with incoming events, and derive follow-up events. */
  onEvent?(ctx: ModuleCtx & { emit(input: EventInput): void; resolve(eventId: string): void }, event: AgentOSEvent, info: { created: boolean }): void;
  /** Extra HTTP routes, mounted under /api/modules/<id>/. */
  routes?(app: Hono<AppEnv>, deps: Deps): void;
}

export interface ModuleCtx {
  db: DB;
  now: Date;
}

/** Seeding also knows which dataset to load: the official material pack, or the fictional test fixtures. */
export interface SeedCtx extends ModuleCtx {
  dataset: Dataset;
}

export interface SituationDraft {
  title: string;
  level: Level;
  headline: string;
  metrics: Metric[];
}

export interface EventTypeDefinition {
  type: string;
  label: string;
  severity: Severity;
  /**
   * 'occurrence' (default): repeats within 10 minutes add to the count, e.g. grasp failures.
   * 'state': a condition such as a stockout risk; re-reports merge while it is unresolved and do not add to the count.
   */
  kind?: 'occurrence' | 'state';
  /** Payload fields that identify a distinct occurrence, e.g. orderId. Repeats with the same values merge. */
  dedupeFields?: string[];
  /** Payload fields hidden from these roles in the API and the live stream. */
  hiddenFields?: Partial<Record<Role, string[]>>;
}

export interface SignalRule {
  id: string;
  types: string[];
  windowMinutes: number;
  /** Raise when the summed event count within the window reaches this value. */
  threshold: number;
  severity: Severity;
  /** Split matching events into separate signals, e.g. per station. Return null to ignore an event. */
  groupBy?(event: AgentOSEvent): string | null;
  describe(events: AgentOSEvent[], group: string | null): { title: string; summary: string };
  /** What the chairman should decide when this signal is active. Used by the decision briefing. */
  playbook: {
    decision: string;
    impact: string;
    owner: string;
    dueHours: number;
    /** How much this belongs on the chairman's desk: 3 = business-level, 1 = handled by a supervisor. */
    weight: 1 | 2 | 3;
  };
}

export interface AgentDefinition {
  id: string;
  module: Domain | 'executive';
  name: string;
  description: string;
  /** Role-specific instructions appended to the shared system prompt. */
  instructions: string;
  starters: string[];
  /** A narrowly scoped employee service, available to every authenticated account. */
  companyService?: boolean;
  /** Prepare grounded analysis; a service can also return an already validated model response. */
  context(ctx: AgentCtx): AgentContext | Promise<AgentContext>;
}

export interface AgentCtx extends ModuleCtx {
  input: string;
  /** Earlier questions in the same conversation, oldest first, for resolving follow-ups. */
  history: string[];
  account: Account;
  deps: Deps;
}

export interface AgentContext {
  /** A module may supply an already validated response, skipping generic model composition. */
  preparedResponse?: { answer: string; mode: 'llm' | 'offline' };
  policy?: PolicyResponse;
  /** One-line conclusion shown when no model is configured. */
  headline?: string;
  /** Data the model must ground its answer in; also rendered as the offline answer. */
  blocks: { title: string; lines: string[] }[];
  facts?: string[];
  pending?: string[];
  suggestions?: string[];
  actions?: ActionItem[];
  artifacts?: Artifact[];
  events?: EventInput[];
}
