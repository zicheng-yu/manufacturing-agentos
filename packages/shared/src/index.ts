// Types shared by the server and the web app. Keep this file free of runtime dependencies.

/** Also the display order of modules in the cockpit and navigation. */
export const DOMAINS = ['production', 'supply', 'quality', 'logistics', 'ehs', 'hr'] as const;
export type Domain = (typeof DOMAINS)[number];

export const ROLES = ['executive', 'production_mgr', 'supply_mgr', 'quality_mgr', 'logistics_mgr', 'ehs_mgr', 'hr_mgr'] as const;
export type Role = (typeof ROLES)[number];

export type Severity = 'info' | 'warn' | 'critical';
export const SEVERITY_LABELS = { info: '提示', warn: '警告', critical: '严重' } as const;
export type EventStatus = 'open' | 'acknowledged' | 'resolved';
export type EventChannel = 'agent' | 'bridge' | 'replay' | 'seed' | 'manual';
export type Level = 'normal' | 'info' | 'watch' | 'alert';
/** Preserve the existing situation keys while using one vocabulary for all visible risk levels. */
export const SEVERITY_TO_LEVEL = { info: 'info', warn: 'watch', critical: 'alert' } as const;
export const LEVEL_LABELS = { normal: '正常', info: SEVERITY_LABELS.info, watch: SEVERITY_LABELS.warn, alert: SEVERITY_LABELS.critical } as const;

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  title: string;
  active: boolean;
  lastLoginAt: string | null;
}

export interface Company {
  name: string;
  shortName: string;
  tagline: string;
  demoNotice: string;
}

export interface Session {
  account: Account;
  company: Company;
  domains: Domain[];
}

export interface ModuleInfo {
  id: Domain;
  name: string;
  description: string;
}

export interface AgentInfo {
  id: string;
  module: Domain | 'executive';
  name: string;
  description: string;
  starters: string[];
  companyService?: boolean;
}

export interface Catalog {
  modules: ModuleInfo[];
  agents: AgentInfo[];
  llm: { mode: 'llm' | 'offline'; model: string | null };
}

export interface EventSource {
  channel: EventChannel;
  station?: string;
  actor?: string;
}

export interface AgentOSEvent {
  id: string;
  domain: Domain;
  type: string;
  typeLabel: string;
  severity: Severity;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  source: EventSource;
  dedupeKey: string;
  count: number;
  status: EventStatus;
  createdAt: string;
  lastSeenAt: string;
  turnId: string | null;
}

export interface Signal {
  id: string;
  ruleId: string;
  domain: Domain;
  severity: Severity;
  title: string;
  summary: string;
  eventIds: string[];
  count: number;
  status: 'active' | 'cleared';
  firstAt: string;
  lastAt: string;
  updatedAt: string;
}

export interface Metric {
  label: string;
  value: string | number;
  unit?: string;
  tone?: 'good' | 'bad' | 'neutral';
}

export interface Situation {
  domain: Domain;
  title: string;
  level: Level;
  headline: string;
  metrics: Metric[];
  signalIds: string[];
}

export interface TableArtifact {
  kind: 'table';
  title: string;
  columns: string[];
  rows: (string | number)[][];
  note?: string;
}

export type Artifact = TableArtifact;

export interface ActionItem {
  title: string;
  owner?: string;
  due?: string;
}

export interface AgentResult {
  title: string;
  answer: string;
  facts: string[];
  pending: string[];
  suggestions: string[];
  actions: ActionItem[];
  artifacts: Artifact[];
  eventIds: string[];
  policy?: PolicyResponse;
  discoveries?: Discovery[];
  reference?: AnalysisReference;
}

export interface Discovery {
  id: string;
  domain: Domain;
  title: string;
  kind: '历史观察' | '规则回测' | '情景估算';
  summary: string;
  source: string;
  scope: string;
  limitation: string;
  agentId: string;
  question: string;
  evidence: TableArtifact;
}

export interface AnalysisReference {
  turnId: string;
  conversationId: string;
  agentId: string;
  createdAt: string;
  refreshedAt?: string;
  summary: string;
}

export interface PolicyCitation {
  sourceId: string;
  documentId: string;
  title: string;
  version: number;
  section: number;
  kind: 'policy' | 'faq';
  quote: string;
  scope: string;
  effectiveFrom: string | null;
}

export interface PolicyResponse {
  outcome: 'answered' | 'clarify' | 'handoff';
  citations: PolicyCitation[];
  questions: string[];
}

export interface KnowledgeVersion {
  id: string;
  documentId: string;
  version: number;
  revision: number;
  kind: 'policy' | 'faq';
  status: 'draft' | 'published';
  title: string;
  category: string;
  keywords: string;
  content: string;
  scope: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  archived: boolean;
  sourceRequestId: string | null;
}

export interface Turn {
  id: string;
  conversationId: string;
  agentId: string;
  input: string;
  result: AgentResult;
  mode: 'llm' | 'offline';
  latencyMs: number;
  createdAt: string;
}

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  domain: Domain | 'executive';
  kind: 'fact' | 'pending' | 'suggestion';
  content: string;
  source: 'agent' | 'event' | 'seed';
  agentId: string | null;
  turnId: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  domain: Domain | 'executive';
  title: string;
  owner: string | null;
  due: string | null;
  status: 'open' | 'done';
  turnId: string | null;
  createdAt: string;
}

export interface Cockpit {
  situations: Situation[];
  signals: Signal[];
  events: AgentOSEvent[];
  tasks: Task[];
  /** Latest decision briefing of the current account (executive only). */
  briefing: Turn | null;
}

export interface ModuleOverview {
  module: ModuleInfo;
  situation: Situation;
  metrics: Metric[];
  tables: TableArtifact[];
}

/** Messages pushed over /api/stream (Server-Sent Events). */
export type StreamMessage =
  | { kind: 'event.created' | 'event.updated'; event: AgentOSEvent }
  | { kind: 'signal.raised' | 'signal.updated' | 'signal.cleared'; signal: Signal }
  | { kind: 'situation.updated'; situation: Situation }
  | { kind: 'task.created'; task: Task };

export const DOMAIN_LABELS: Record<Domain, string> = {
  production: '生产设备',
  supply: '供应链',
  quality: '品质',
  hr: 'HR',
  logistics: '智能物流',
  ehs: '能源安全',
};

export const ROLE_LABELS: Record<Role, string> = {
  executive: '董事长',
  production_mgr: '生产经理',
  ehs_mgr: '安环经理',
  supply_mgr: '供应链经理',
  quality_mgr: '品质经理',
  hr_mgr: 'HR 经理',
  logistics_mgr: '物流主管',
};
