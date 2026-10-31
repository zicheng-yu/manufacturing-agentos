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
  /** Set when the answer was produced for a collaboration case. */
  caseId?: string;
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

// --- Collaboration cases (YOU-143): one durable item, several roles, a verifiable outcome ---------------------

export const CASE_STATUSES = ['pending', 'active', 'verifying', 'verified'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = { pending: '待处理', active: '处理中', verifying: '待验证', verified: '已验证' };

/** A typed reference to a business object. The source tables stay the source of truth; a case keeps references. */
export interface CaseObjectRef {
  type: 'material' | 'supplier' | 'equipment' | 'order' | 'complaint' | 'agv' | 'finding';
  id: string;
  label?: string;
  /** Modules whose records mention it; a viewer sees the reference only if they can see one of them. */
  domains: Domain[];
}

export const OBJECT_TYPE_LABELS: Record<CaseObjectRef['type'], string> = {
  material: '物料',
  supplier: '供应商',
  equipment: '设备',
  order: '订单',
  complaint: '客诉',
  agv: 'AGV',
  finding: '数据发现',
};

export interface CaseOrigin {
  kind: 'signal' | 'discovery';
  id: string;
  /** The signal rule or discovery id, used to match similar cases. */
  ruleId: string;
  domain: Domain;
  title: string;
  summary: string;
  severity: Severity | null;
}

export interface CaseSummary {
  id: string;
  goal: string;
  status: CaseStatus;
  /** A new round starts when fresh evidence overturns a verified result. */
  round: number;
  needsReview: boolean;
  owner: { name: string; title: string };
  /** Null when the viewer may not see the origin's domain. */
  origin: CaseOrigin | null;
  originDomain: Domain;
  objects: CaseObjectRef[];
  domains: Domain[];
  createdAt: string;
  updatedAt: string;
}

export type CaseEntryKind = 'evidence' | 'analysis' | 'action' | 'receipt' | 'verification' | 'reference';

export interface CaseEntry {
  id: string;
  kind: CaseEntryKind;
  /** The module the content belongs to; 'executive' content is chairman-only. */
  domain: Domain | 'executive';
  round: number;
  author: { type: 'agent' | 'person' | 'system'; name: string; title?: string };
  title: string;
  body: string;
  facts: string[];
  pending: string[];
  suggestions: string[];
  artifacts: Artifact[];
  /** Kind-specific fields: signalId and events for evidence, taskId for actions, mode and passed for verification. */
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CaseCandidate {
  signalId: string;
  domain: Domain;
  severity: Severity;
  title: string;
  /** Why it may be related, e.g. 共同物料 M-10003. A shared entity or tag is a lead, not a verified cause. */
  basis: string[];
  added: boolean;
}

/** A reading recomputed from current business data when the case is opened. */
export interface CaseLive {
  domain: Domain;
  label: string;
  value: string;
  ok: boolean;
  source: string;
}

export interface Lesson {
  id: string;
  sourceCaseId: string;
  title: string;
  domain: Domain;
  symptom: string;
  conditions: string;
  measure: string;
  result: string;
  conclusion: 'effective' | 'ineffective';
  verification: { mode: 'auto' | 'manual'; passed: boolean; at: string; criterion: string };
  tags: string[];
  confirmedBy: string;
  confirmedAt: string;
}

export interface CaseAgentOption {
  id: string;
  name: string;
  domain: Domain | 'executive';
  description: string;
  starters: string[];
}

export interface CaseDetail {
  summary: CaseSummary;
  /** Only entries the viewer's role may see; the rest are counted in hiddenEntries. */
  entries: CaseEntry[];
  hiddenEntries: number;
  tasks: Task[];
  candidates: CaseCandidate[];
  live: CaseLive[];
  agents: CaseAgentOption[];
  lesson: Lesson | null;
  similarLessons: Lesson[];
  /** The owner and the chairman submit for verification, verify and save lessons. */
  canManage: boolean;
  canAutoVerify: boolean;
}
