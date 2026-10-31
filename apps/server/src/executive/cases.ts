// Collaboration cases (YOU-143): one durable business item that several roles work on in turn.
// A case keeps references and the process; the business tables stay the source of truth. It lives in executive/
// because it reads across modules (signals from any domain, the supply stock table for verification).
import {
  CASE_STATUS_LABELS,
  DOMAIN_LABELS,
  OBJECT_TYPE_LABELS,
  type Account,
  type ActionItem,
  type AgentOSEvent,
  type Artifact,
  type CaseAgentOption,
  type CaseCandidate,
  type CaseDetail,
  type CaseEntry,
  type CaseEntryKind,
  type CaseLive,
  type CaseObjectRef,
  type CaseOrigin,
  type CaseStatus,
  type CaseSummary,
  type Discovery,
  type Domain,
  type Lesson,
  type Signal,
  type Task,
} from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { resolveReference } from '../core/agents/handoff.ts';
import { runTurn } from '../core/agents/runtime.ts';
import type { Deps } from '../core/deps.ts';
import { getEvent, redactEvent } from '../core/events.ts';
import { getTask, setTaskStatus } from '../core/memory.ts';
import { canSee, canUseAgent, domainsFor } from '../core/roles.ts';
import { listSignals, rowToSignal, signalEvents } from '../core/signals.ts';
import { newId, unique } from '../core/util.ts';
import { parseJson, transaction, type Row } from '../db.ts';
import { coverText, listMaterials, materialStatus } from '../modules/supply/data.ts';

type Scope = Domain | 'executive';

interface CaseRow {
  id: string;
  goal: string;
  origin: CaseOrigin;
  objects: CaseObjectRef[];
  causes: string[];
  status: CaseStatus;
  round: number;
  needsReview: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

interface StoredEntry {
  id: string;
  kind: CaseEntryKind;
  domain: Scope;
  round: number;
  author: CaseEntry['author'];
  title: string;
  body: string;
  facts: string[];
  pending: string[];
  suggestions: string[];
  artifacts: Artifact[];
  data: Record<string, any>;
  turnId: string | null;
  createdAt: string;
}

const KIND_LABELS: Record<CaseEntryKind, string> = { evidence: '证据', analysis: '分析', action: '处置', receipt: '回执', verification: '验证', reference: '引用经验' };
const SYSTEM = { type: 'system', name: '系统' } as const;
const fail = (status: 400 | 403 | 404 | 409, message: string): never => { throw new HTTPException(status, { message }); };
const personOf = (account: Account): CaseEntry['author'] => ({ type: 'person', name: account.displayName, title: account.title });

// --- Reading and writing rows ---------------------------------------------------------------------------------

function readCase(deps: Deps, id: string): CaseRow {
  const row = deps.db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as Row | undefined;
  if (!row) return fail(404, '事项不存在');
  return {
    id: String(row.id),
    goal: String(row.goal),
    origin: parseJson<CaseOrigin>(row.origin_json, {} as CaseOrigin),
    objects: parseJson<CaseObjectRef[]>(row.objects_json, []),
    causes: parseJson<string[]>(row.causes_json, []),
    status: row.status as CaseStatus,
    round: Number(row.round),
    needsReview: Number(row.needs_review) === 1,
    ownerId: String(row.owner_account_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    verifiedAt: (row.verified_at as string | null) ?? null,
  };
}

function loadEntries(deps: Deps, caseId: string): StoredEntry[] {
  const rows = deps.db.prepare('SELECT * FROM case_entries WHERE case_id = ? ORDER BY created_at, rowid').all(caseId) as Row[];
  return rows.map((row) => {
    const stored = parseJson<Partial<StoredEntry>>(row.data_json, {});
    return {
      id: String(row.id),
      kind: row.kind as CaseEntryKind,
      domain: row.domain as Scope,
      round: Number(row.round),
      author: parseJson<CaseEntry['author']>(row.author_json, SYSTEM),
      title: stored.title ?? '',
      body: stored.body ?? '',
      facts: stored.facts ?? [],
      pending: stored.pending ?? [],
      suggestions: stored.suggestions ?? [],
      artifacts: stored.artifacts ?? [],
      data: stored.data ?? {},
      turnId: (row.turn_id as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  });
}

interface NewEntry {
  kind: CaseEntryKind;
  domain: Scope;
  author: CaseEntry['author'];
  title: string;
  body?: string;
  facts?: string[];
  pending?: string[];
  suggestions?: string[];
  artifacts?: Artifact[];
  data?: Record<string, unknown>;
  turnId?: string | null;
}

function addEntry(deps: Deps, row: CaseRow, input: NewEntry): string {
  const id = newId('CEN');
  const now = deps.clock().toISOString();
  const { kind, domain, author, turnId, ...content } = input;
  deps.db
    .prepare('INSERT INTO case_entries (id, case_id, kind, domain, author_json, round, data_json, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, row.id, kind, domain, JSON.stringify(author), row.round, JSON.stringify(content), turnId ?? null, now);
  deps.db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now, row.id);
  return id;
}

// --- Who may see what -----------------------------------------------------------------------------------------

const visibleTo = (account: Account) => (entry: { domain: Scope }) => canSee(account.role, entry.domain);

/** The origin's module, or any module that contributed: joining a case never opens the other departments' data. */
function canOpen(account: Account, row: CaseRow, entries: StoredEntry[]): boolean {
  return canSee(account.role, row.origin.domain) || entries.some(visibleTo(account));
}

function mustOpen(account: Account, row: CaseRow, entries: StoredEntry[]): void {
  if (!canOpen(account, row, entries)) fail(404, '事项不存在');
}

const canManage = (account: Account, row: CaseRow) => account.id === row.ownerId || account.role === 'executive';

function mustManage(account: Account, row: CaseRow): void {
  if (!canManage(account, row)) fail(403, '仅事项负责人或董事长可执行此操作');
}

// --- Business objects ------------------------------------------------------------------------------------------

const OBJECT_FIELDS: [string, CaseObjectRef['type']][] = [
  ['materialCode', 'material'],
  ['supplierName', 'supplier'],
  ['supplier', 'supplier'],
  ['equipmentId', 'equipment'],
  ['orderId', 'order'],
  ['complaintId', 'complaint'],
  ['agv', 'agv'],
];

const objectKey = (o: Pick<CaseObjectRef, 'type' | 'id'>) => `${o.type}:${o.id}`;

function mergeObject(a: CaseObjectRef | undefined, b: CaseObjectRef): CaseObjectRef {
  return a ? { ...a, label: a.label ?? b.label, domains: unique([...a.domains, ...b.domains]) } : b;
}

function mergeObjects(a: CaseObjectRef[], b: CaseObjectRef[]): CaseObjectRef[] {
  const merged = new Map(a.map((o) => [objectKey(o), o]));
  for (const o of b) merged.set(objectKey(o), mergeObject(merged.get(objectKey(o)), o));
  return [...merged.values()];
}

/** Typed references found in events. A supplier is keyed by name, the one spelling every module uses. */
export function objectsFromEvents(events: AgentOSEvent[]): { objects: CaseObjectRef[]; causes: string[] } {
  const objects = new Map<string, CaseObjectRef>();
  const causes: string[] = [];
  for (const event of events) {
    for (const [field, type] of OBJECT_FIELDS) {
      const value = event.payload[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      const ref: CaseObjectRef = { type, id: value.trim(), domains: [event.domain] };
      if (type === 'material' && typeof event.payload.materialName === 'string') ref.label = event.payload.materialName;
      objects.set(objectKey(ref), mergeObject(objects.get(objectKey(ref)), ref));
    }
    const tags = event.payload.causes;
    for (const tag of Array.isArray(tags) ? tags : []) if (typeof tag === 'string') causes.push(tag);
  }
  return { objects: [...objects.values()], causes: unique(causes) };
}

function growCase(deps: Deps, row: CaseRow, events: AgentOSEvent[]): void {
  const found = objectsFromEvents(events);
  deps.db
    .prepare('UPDATE cases SET objects_json = ?, causes_json = ? WHERE id = ?')
    .run(JSON.stringify(mergeObjects(row.objects, found.objects)), JSON.stringify(unique([...row.causes, ...found.causes])), row.id);
}

// --- Creating a case -------------------------------------------------------------------------------------------

function insertCase(
  deps: Deps,
  account: Account,
  input: { sourceKey: string; goal: string; origin: CaseOrigin; objects: CaseObjectRef[]; causes: string[]; evidence: NewEntry },
): { id: string; created: boolean } {
  const existing = deps.db.prepare('SELECT id FROM cases WHERE source_key = ?').get(input.sourceKey) as Row | undefined;
  if (existing) return { id: String(existing.id), created: false };
  const id = newId('CASE');
  const now = deps.clock().toISOString();
  transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO cases (id, source_key, goal, origin_json, objects_json, causes_json, status, round, needs_review, owner_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, 0, ?, ?, ?)`,
      )
      .run(id, input.sourceKey, input.goal, JSON.stringify(input.origin), JSON.stringify(input.objects), JSON.stringify(input.causes), account.id, now, now);
    addEntry(deps, readCase(deps, id), input.evidence);
  });
  return { id, created: true };
}

function signalEvidence(signal: Signal, events: AgentOSEvent[], prefix: string, author: CaseEntry['author'], extra: Record<string, unknown> = {}): NewEntry {
  return {
    kind: 'evidence',
    domain: signal.domain,
    author,
    title: `${prefix}：${signal.title}`,
    body: signal.summary,
    facts: [`${DOMAIN_LABELS[signal.domain]}「${signal.title}」：${signal.summary}（累计 ${signal.count} 次，${events.length} 个事件）`],
    data: { signalId: signal.id, eventIds: events.map((e) => e.id), ...extra },
  };
}

/** The same source always opens the same case; the same material with a different problem is a different case. */
export function createFromSignal(deps: Deps, account: Account, signalId: string): { id: string; created: boolean } {
  const row = deps.db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as Row | undefined;
  const signal = row ? rowToSignal(row) : null;
  if (!signal || !canSee(account.role, signal.domain)) return fail(404, '信号不存在');
  const existing = deps.db.prepare('SELECT id FROM cases WHERE source_key = ?').get(`signal:${signalId}`) as Row | undefined;
  // A signal that has since cleared can still reopen the case it started, but cannot start a new one.
  if (signal.status !== 'active' && !existing) return fail(409, '该信号已解除，不能发起新事项');
  const events = signalEvents(deps, signal);
  const found = objectsFromEvents(events);
  return insertCase(deps, account, {
    sourceKey: `signal:${signal.id}`,
    goal: `核查「${signal.title}」并跟踪处置`,
    origin: { kind: 'signal', id: signal.id, ruleId: signal.ruleId, domain: signal.domain, title: signal.title, summary: signal.summary, severity: signal.severity },
    ...found,
    evidence: signalEvidence(signal, events, '信号', personOf(account)),
  });
}

function discoveryEvidence(finding: Discovery, turnId: string, author: CaseEntry['author']): NewEntry {
  return {
    kind: 'evidence',
    domain: finding.domain,
    author,
    title: `数据发现：${finding.title}`,
    body: finding.summary,
    facts: [`【${finding.kind}】${finding.summary}`],
    pending: [finding.limitation],
    artifacts: [finding.evidence],
    data: { findingId: finding.id, sourceTurnId: turnId, source: finding.source, scope: finding.scope },
  };
}

/** The finding is recomputed from the database first, so a case never starts from a stale stored snapshot. */
export async function createFromDiscovery(deps: Deps, account: Account, turnId: string, findingId: string): Promise<{ id: string; created: boolean }> {
  const { finding } = await resolveReference(deps, account, turnId, findingId);
  if (!finding || !canSee(account.role, finding.domain)) return fail(404, '数据发现不存在');
  return insertCase(deps, account, {
    sourceKey: `finding:${finding.id}`,
    goal: `核查「${finding.title}」并跟踪处置`,
    origin: { kind: 'discovery', id: finding.id, ruleId: finding.id, domain: finding.domain, title: finding.title, summary: finding.summary, severity: null },
    objects: [{ type: 'finding', id: finding.id, label: finding.title, domains: [finding.domain] }],
    causes: [],
    evidence: discoveryEvidence(finding, turnId, personOf(account)),
  });
}

// --- Evidence that keeps arriving ------------------------------------------------------------------------------

/**
 * Pick up what changed since the case last looked: new events on its signals become evidence, and a verified case
 * is flagged for review when an event it relied on is seen again after the verification.
 */
export function syncCase(deps: Deps, id: string): void {
  const row = readCase(deps, id);
  const known = new Map<string, Set<string>>();
  for (const entry of loadEntries(deps, id)) {
    if (entry.kind !== 'evidence' || typeof entry.data.signalId !== 'string') continue;
    const ids = known.get(entry.data.signalId) ?? new Set<string>();
    for (const eventId of entry.data.eventIds ?? []) ids.add(String(eventId));
    known.set(entry.data.signalId, ids);
  }
  let flagged = row.needsReview;
  for (const [signalId, seen] of known) {
    const signalRow = deps.db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as Row | undefined;
    const signal = signalRow ? rowToSignal(signalRow) : null;
    if (!signal || signal.status !== 'active') continue;
    const events = signalEvents(deps, signal);
    const fresh = events.filter((e) => !seen.has(e.id));
    if (fresh.length) {
      growCase(deps, readCase(deps, id), fresh);
      addEntry(deps, row, {
        kind: 'evidence',
        domain: signal.domain,
        author: SYSTEM,
        title: `信号更新：${signal.title}`,
        body: `该信号新增 ${fresh.length} 个关联事件：${fresh.map((e) => e.title).join('；')}`,
        facts: fresh.map((e) => `${e.typeLabel}：${e.title}`),
        data: { signalId, eventIds: fresh.map((e) => e.id), update: true },
      });
    }
    if (row.status === 'verified' && row.verifiedAt && !flagged && events.some((e) => e.lastSeenAt > row.verifiedAt!)) {
      flagged = true;
      deps.db.prepare('UPDATE cases SET needs_review = 1 WHERE id = ?').run(id);
      addEntry(deps, row, {
        kind: 'evidence',
        domain: signal.domain,
        author: SYSTEM,
        title: '验证后再次出现同源信号，已验证结论需复核',
        body: `「${signal.title}」在验证之后仍有新的记录。上一次验证保留在历史中，不被覆盖；负责人确认后可重新开启处置。`,
        pending: ['已验证结论可能已被新证据推翻，需负责人复核'],
        data: { signalId, eventIds: [], review: true },
      });
    }
  }
}

// --- Leads from other departments ------------------------------------------------------------------------------

const DEPARTMENT_DOMAIN: Record<string, Domain> = { 供应链部: 'supply', 品质部: 'quality', 智能物流部: 'logistics' };

/** Active signals that share an object or cause tag with the case. A shared entity is a lead, never a verified cause. */
function candidatesFor(deps: Deps, account: Account, row: CaseRow, entries: StoredEntry[]): CaseCandidate[] {
  const keyed = new Map<string, string>();
  for (const o of row.objects) if (o.type !== 'finding') keyed.set(objectKey(o), `共同${OBJECT_TYPE_LABELS[o.type]} ${o.id}`);
  for (const cause of row.causes) keyed.set(`cause:${cause}`, `共同原因标签 ${cause}`);
  const added = new Set(entries.filter((e) => e.kind === 'evidence').map((e) => e.data.signalId));
  // Which departments are in the case is itself information: only count the ones this viewer is allowed to see.
  const involved = new Set<Domain>([row.origin.domain, ...entries.map((e) => e.domain).filter((d): d is Domain => d !== 'executive')].filter((d) => canSee(account.role, d)));
  const out: CaseCandidate[] = [];
  for (const signal of listSignals(deps, domainsFor(account.role))) {
    if (signal.id === row.origin.id) continue;
    const events = signalEvents(deps, signal);
    const found = objectsFromEvents(events);
    const basis: string[] = [...found.objects.map(objectKey), ...found.causes.map((c) => `cause:${c}`)].flatMap((key) => (keyed.has(key) ? [keyed.get(key)!] : []));
    if (signal.ruleId === 'hr-team-attrition') {
      for (const event of events) {
        const related = DEPARTMENT_DOMAIN[String(event.payload.department ?? '')];
        if (related && involved.has(related)) basis.push(`人员风险叠加：${event.payload.department}减员预警与${DOMAIN_LABELS[related]}风险同时存在，处置人手可能不足（需负责人核实）`);
      }
    }
    if (basis.length) out.push({ signalId: signal.id, domain: signal.domain, severity: signal.severity, title: signal.title, basis: unique(basis), added: added.has(signal.id) });
  }
  const rank = { critical: 2, warn: 1, info: 0 } as const;
  return out.sort((a, b) => Number(a.added) - Number(b.added) || rank[b.severity] - rank[a.severity]);
}

export function addCandidate(deps: Deps, account: Account, id: string, signalId: string): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  if (row.status === 'verified') fail(409, '事项已验证，请先重新开启再追加证据');
  const candidate = candidatesFor(deps, account, row, entries).find((c) => c.signalId === signalId);
  if (!candidate) return fail(404, '该信号不在可关联的线索中');
  if (candidate.added) return fail(409, '该信号已加入事项');
  const signal = rowToSignal(deps.db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as Row);
  const events = signalEvents(deps, signal);
  growCase(deps, row, events);
  addEntry(deps, row, signalEvidence(signal, events, '关联信号', personOf(account), { basis: candidate.basis }));
}

// --- What an assistant is told ---------------------------------------------------------------------------------

const clip = (text: string, length: number) => text.replace(/\s+/g, ' ').trim().slice(0, length);

/**
 * The assistant's answer is stored under the assistant's own module, so everyone who can read that module can read
 * it. The background it is given must therefore be limited to what that module may see, not what the asker may see:
 * otherwise the chairman asking supply's assistant would carry HR or quality content into a supply-readable entry.
 * Only a cross-department assistant (module 'executive') is briefed with everything the asker can see.
 */
function caseBrief(account: Account, audience: Scope, row: CaseRow, entries: StoredEntry[]): string {
  const seen = (domain: Scope) => canSee(account.role, domain) && (audience === 'executive' || domain === audience);
  const visible = entries.filter((e) => seen(e.domain));
  const originVisible = seen(row.origin.domain);
  const objects = row.objects.filter((o) => o.domains.some(seen));
  const lines = [
    `事项 ${row.id}：${originVisible ? row.goal : '跨部门协作事项（来源部门不在你的权限内）'}`,
    `状态：${CASE_STATUS_LABELS[row.status]}，第 ${row.round} 轮处置`,
    ...(objects.length ? [`关联对象：${objects.map((o) => `${OBJECT_TYPE_LABELS[o.type]} ${o.id}${o.label ? `（${o.label}）` : ''}`).join('、')}`] : []),
  ];
  const contributions = visible.filter((e) => ['analysis', 'receipt', 'verification', 'action'].includes(e.kind)).slice(-8);
  if (contributions.length) {
    lines.push('其他岗位已有的贡献：');
    for (const e of contributions) lines.push(`- [${e.domain === 'executive' ? '经营决策' : DOMAIN_LABELS[e.domain]}｜${e.author.name}｜第 ${e.round} 轮｜${KIND_LABELS[e.kind]}] ${e.title}：${clip(e.body, 200)}`);
  }
  const pending = unique(visible.filter((e) => e.kind === 'analysis').flatMap((e) => e.pending)).slice(0, 5);
  if (pending.length) lines.push(`尚待核实：${pending.join('；')}`);
  return lines.join('\n');
}

export async function askInCase(deps: Deps, account: Account, id: string, agentId: string, question: string): Promise<void> {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  if (row.status === 'verified') fail(409, '事项已验证，请先重新开启再继续分析');
  const agent = deps.registry.agent(agentId);
  if (agent.companyService) fail(400, '员工自助助手只服务个人，不参与协作事项');
  if (!canUseAgent(account.role, agent)) fail(403, '当前账号无权使用该智能体');
  const text = question.trim();
  if (!text) fail(400, '问题不能为空');
  const { conversation, turn } = await runTurn(deps, { account, agentId, question: text, caseContext: { caseId: id, summary: caseBrief(account, agent.module, row, entries) } });
  // The model call can be slow. If the owner finished the case meanwhile, the answer stays in the asker's
  // conversation but is not added to a case that has already been verified.
  const current = readCase(deps, id);
  if (current.status === 'verified') return fail(409, '事项在分析期间已完成验证，本次回答保留在你的对话中，未加入事项');
  addEntry(deps, current, {
    kind: 'analysis',
    domain: agent.module,
    author: { type: 'agent', name: agent.name },
    title: turn.result.title || agent.name,
    body: turn.result.answer,
    facts: turn.result.facts,
    pending: turn.result.pending,
    suggestions: turn.result.suggestions,
    artifacts: turn.result.artifacts,
    turnId: turn.id,
    // The raw question stays in the asker's own conversation: the module's readers must not see what, say, the
    // chairman typed. Only who asked and which assistant answered are kept on the case.
    data: { askedBy: account.displayName, mode: turn.mode, actions: turn.result.actions },
  });
}

// --- Actions, receipts, verification ---------------------------------------------------------------------------

function newTask(deps: Deps, input: { domain: Scope; title: string; owner?: string | null; due?: string | null }): Task {
  const id = newId('TSK');
  deps.db
    .prepare(`INSERT INTO tasks (id, domain, title, owner, due, status, turn_id, created_at) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?)`)
    .run(id, input.domain, input.title, input.owner ?? null, input.due ?? null, deps.clock().toISOString());
  const task = getTask(deps.db, id)!;
  deps.bus.publish({ kind: 'task.created', task });
  return task;
}

export interface ActionInput {
  fromEntryId?: string;
  actionIndex?: number;
  title?: string;
  domain?: Domain;
  owner?: string;
  due?: string;
}

/** The owner turns a suggestion into a tracked disposition: it reuses the assistant's to-do or creates one. */
export function confirmAction(deps: Deps, account: Account, id: string, input: ActionInput): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  mustManage(account, row);
  if (row.status === 'verifying' || row.status === 'verified') fail(409, '当前状态不能再新增处置');
  let task: Task;
  let fromEntryId: string | undefined;
  if (input.fromEntryId) {
    const source = entries.find((e) => e.id === input.fromEntryId && e.kind === 'analysis' && canSee(account.role, e.domain));
    const action = (source?.data.actions as ActionItem[] | undefined)?.[input.actionIndex ?? -1];
    if (!source || !action) return fail(404, '找不到这条分析中的行动项');
    fromEntryId = source.id;
    const existing = source.turnId
      ? (deps.db
          .prepare('SELECT t.id FROM tasks t JOIN task_turn_sources s ON s.task_id = t.id WHERE s.turn_id = ? AND t.title = ? LIMIT 1')
          .get(source.turnId, action.title) as Row | undefined)
      : undefined;
    // Reuse the assistant's to-do only while it is still open and not already this case's: a task finished in an
    // earlier round, or one tracked by another case, must not be silently shared.
    const reusable = existing ? getTask(deps.db, String(existing.id)) : null;
    const claimed = reusable && deps.db.prepare("SELECT 1 FROM case_entries WHERE kind = 'action' AND data_json LIKE ? AND case_id <> ?").get(`%"taskId":"${reusable.id}"%`, id);
    task = (reusable && reusable.status === 'open' && !claimed && reusable) || newTask(deps, { domain: source.domain, title: action.title, owner: action.owner, due: action.due });
  } else {
    const title = (input.title ?? '').trim();
    if (title.length < 2) return fail(400, '请填写处置内容');
    if (!input.domain || !domainsFor(account.role).includes(input.domain)) return fail(400, '请选择你有权限的责任部门');
    // A free-form disposition creates its own to-do, so the same wording must be caught before it does.
    if (entries.some((e) => e.kind === 'action' && e.round === row.round && e.domain === input.domain && e.title === title)) return fail(409, '本轮已登记相同的处置');
    task = newTask(deps, { domain: input.domain, title, owner: input.owner?.trim() || `${DOMAIN_LABELS[input.domain]}负责人`, due: input.due || null });
  }
  if (entries.some((e) => e.kind === 'action' && e.data.taskId === task.id && e.round === row.round)) return fail(409, '该行动项已确认为本事项的处置');
  addEntry(deps, row, {
    kind: 'action',
    domain: task.domain,
    author: personOf(account),
    title: task.title,
    body: `责任：${task.owner ?? '待指定'}${task.due ? `；期限 ${task.due}` : ''}`,
    data: { taskId: task.id, owner: task.owner, due: task.due, ...(fromEntryId ? { fromEntryId } : {}) },
  });
  if (row.status === 'pending') deps.db.prepare(`UPDATE cases SET status = 'active' WHERE id = ?`).run(id);
}

/** A receipt says the disposition was carried out. It does not say the problem is gone; verification does. */
export function confirmReceipt(deps: Deps, account: Account, id: string, input: { actionEntryId: string; note: string; simulated: boolean }): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  if (row.status === 'verified') fail(409, '事项已验证，请先重新开启');
  const action = entries.find((e) => e.id === input.actionEntryId && e.kind === 'action');
  if (!action || !canSee(account.role, action.domain)) return fail(404, '找不到这项处置');
  if (entries.some((e) => e.kind === 'receipt' && e.data.actionEntryId === action.id)) fail(409, '这项处置已有回执');
  const note = input.note.trim();
  if (note.length < 2) return fail(400, '请写明执行情况');
  addEntry(deps, row, {
    kind: 'receipt',
    domain: action.domain,
    author: personOf(account),
    title: `回执：${action.title}`,
    body: note,
    data: { actionEntryId: action.id, taskId: action.data.taskId, simulated: input.simulated },
  });
  // Mark the to-do done only when this case is its sole owner; a shared to-do belongs to someone else's record too.
  const taskId = action.data.taskId;
  if (typeof taskId === 'string' && !deps.db.prepare("SELECT 1 FROM case_entries WHERE kind = 'action' AND data_json LIKE ? AND case_id <> ?").get(`%"taskId":"${taskId}"%`, id)) setTaskStatus(deps.db, taskId, 'done');
}

export function submitForVerification(deps: Deps, account: Account, id: string): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  mustManage(account, row);
  if (row.status !== 'active') fail(409, '只有处理中的事项可以提交验证');
  // Every disposition across rounds needs a receipt. After a failed check the data may have moved on by itself,
  // so the owner can ask for another check without being forced to invent a new action.
  const actions = entries.filter((e) => e.kind === 'action');
  if (!actions.length) fail(409, '还没有确认的处置');
  const missing = actions.filter((a) => !entries.some((e) => e.kind === 'receipt' && e.data.actionEntryId === a.id));
  if (missing.length) fail(409, `还有 ${missing.length} 项处置没有回执`);
  deps.db.prepare(`UPDATE cases SET status = 'verifying', updated_at = ? WHERE id = ?`).run(deps.clock().toISOString(), id);
}

/**
 * Readings recomputed from business data now. Only the stock table can be recomputed; other objects need a person.
 * The recomputation is a valid check only for a case that is about stock, and only if it covers every material the
 * case names: a delivery-timeout case that merely mentions M-10003 must not be "verified" by stock turning normal.
 */
export function liveReadings(deps: Deps, row: Pick<CaseRow, 'objects' | 'origin'>): CaseLive[] {
  if (row.origin.ruleId !== 'supply-stockout') return [];
  const materials = listMaterials(deps.db, deps.clock());
  const named = row.objects.filter((o) => o.type === 'material');
  const found = named.flatMap((o) => materials.find((x) => x.code === o.id) ?? []);
  if (!named.length || found.length !== named.length) return [];
  return found.map((m) => {
    const status = materialStatus(m);
    return { domain: 'supply' as const, label: `${m.code} ${m.name} 库存状态`, value: `${status}：库存 ${m.onHand} ${m.unit}，${coverText(m)}`, ok: status === '正常', source: '供应链库存表当前读数' };
  });
}

export interface VerifyInput {
  mode: 'auto' | 'manual';
  passed?: boolean;
  criterion?: string;
  note?: string;
}

export function verifyCase(deps: Deps, account: Account, id: string, input: VerifyInput): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  mustManage(account, row);
  if (row.status !== 'verifying') fail(409, '只有待验证的事项可以验证');
  const now = deps.clock().toISOString();
  let passed: boolean;
  let criterion: string;
  let body: string;
  let observed: string[];
  if (input.mode === 'auto') {
    // The stock reading belongs to supply; a viewer without that module cannot trigger or learn it.
    const readings = liveReadings(deps, row);
    if (!readings.length || readings.some((r) => !canSee(account.role, r.domain))) return fail(409, '这个事项没有可由系统重新计算的业务读数，请改用人工核验');
    passed = readings.every((r) => r.ok);
    criterion = '涉及物料的库存状态恢复为「正常」（按当前库存、在途订单和日耗重新计算）';
    observed = readings.map((r) => `${r.label}：${r.value}（${r.source}）`);
    body = passed
      ? `系统按当前业务数据重新计算：${observed.join('；')}`
      : `验证未通过：${readings.filter((r) => !r.ok).map((r) => `${r.label}仍为 ${r.value}`).join('；')}。处置回执不代表问题已消失，事项回到处理中。`;
  } else {
    if (typeof input.passed !== 'boolean') return fail(400, '请选择验证是否通过');
    criterion = (input.criterion ?? '').trim();
    const note = (input.note ?? '').trim();
    if (criterion.length < 4 || note.length < 4) return fail(400, '人工核验需要写明判据和证据来源');
    passed = input.passed;
    observed = [note];
    body = `人工核验（非系统自动证实）：${note}${passed ? '' : '。验证未通过，事项回到处理中。'}`;
  }
  transaction(deps.db, () => {
    addEntry(deps, row, {
      kind: 'verification',
      domain: row.origin.domain,
      author: input.mode === 'auto' ? SYSTEM : personOf(account),
      title: `${passed ? '验证通过' : '验证未通过'}（${input.mode === 'auto' ? '系统重算' : '人工核验'}）`,
      body,
      data: { mode: input.mode, passed, criterion, observed, at: now, confirmer: account.displayName },
    });
    if (passed) deps.db.prepare(`UPDATE cases SET status = 'verified', verified_at = ?, needs_review = 0, updated_at = ? WHERE id = ?`).run(now, now, id);
    else deps.db.prepare(`UPDATE cases SET status = 'active', round = round + 1, updated_at = ? WHERE id = ?`).run(now, id);
  });
}

export function reopenCase(deps: Deps, account: Account, id: string): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  mustManage(account, row);
  if (row.status !== 'verified') fail(409, '只有已验证的事项可以重新开启');
  const now = deps.clock().toISOString();
  transaction(deps.db, () => {
    deps.db.prepare(`UPDATE cases SET status = 'active', round = round + 1, needs_review = 0, verified_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
    addEntry(deps, { ...row, round: row.round + 1 }, { kind: 'evidence', domain: row.origin.domain, author: personOf(account), title: '重新开启处置', body: '负责人确认需要新一轮处置，之前的处置、回执和验证记录保留在历史中。', data: { reopened: true } });
  });
}

// --- Lessons ---------------------------------------------------------------------------------------------------

function rowToLesson(row: Row): Lesson {
  const data = parseJson<Partial<Lesson>>(row.data_json, {});
  return {
    id: String(row.id),
    sourceCaseId: String(row.source_case_id),
    title: String(row.title),
    domain: row.domain as Domain,
    symptom: data.symptom ?? '',
    conditions: data.conditions ?? '',
    measure: data.measure ?? '',
    result: data.result ?? '',
    conclusion: data.conclusion ?? 'effective',
    verification: data.verification!,
    tags: parseJson<string[]>(row.tags_json, []),
    confirmedBy: String(row.confirmed_by),
    confirmedAt: String(row.confirmed_at),
  };
}

const lessonTags = (row: CaseRow) => unique([`rule:${row.origin.ruleId}`, ...row.objects.map(objectKey), ...row.causes.map((c) => `cause:${c}`)]);

/** Free text written by someone who sees every department must not quote another department's action titles. */
function sameDomainOnly(text: string, entries: StoredEntry[], row: CaseRow): string | null {
  const foreign = entries.filter((e) => e.kind === 'action' && e.domain !== row.origin.domain).map((e) => e.title);
  return foreign.some((title) => title.length >= 4 && text.includes(title)) ? null : text;
}

/** A person confirms what is worth keeping; nothing is saved automatically from a model answer or an old number. */
export function saveLesson(
  deps: Deps,
  account: Account,
  id: string,
  input: { title?: string; symptom?: string; conditions: string; measure?: string; conclusion: 'effective' | 'ineffective' },
): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  mustManage(account, row);
  if (row.status !== 'verified') fail(409, '只有已验证的事项可以沉淀经验');
  if (row.needsReview) fail(409, '验证之后又出现了新证据，请先复核或重新开启，再沉淀经验');
  if (deps.db.prepare('SELECT 1 FROM case_lessons WHERE source_case_id = ?').get(id)) fail(409, '该事项已保存经验卡');
  const conditions = input.conditions.trim();
  if (conditions.length < 4) fail(400, '请写明适用条件');
  const verification = entries.filter((e) => e.kind === 'verification' && e.data.passed === true).at(-1);
  if (!verification) return fail(409, '没有通过的验证记录');
  const mode = verification.data.mode as 'auto' | 'manual';
  // A lesson is readable by the origin department, so it may only describe what that department can see, and only
  // the round that actually passed: measures from rounds that failed the check are not evidence that something works.
  const measure = (input.measure?.trim() && sameDomainOnly(input.measure.trim(), entries, row)) ||
    entries.filter((e) => e.kind === 'action' && e.round === verification.round && e.domain === row.origin.domain).map((e) => e.title).join('；') ||
    '（本轮处置由其他部门负责，详见来源事项）';
  const lesson = {
    symptom: input.symptom?.trim() || `${row.origin.title}：${row.origin.summary}`,
    conditions,
    measure,
    result: `${mode === 'auto' ? '系统重算' : '人工核验'}通过：${(verification.data.observed as string[]).join('；')}`,
    conclusion: input.conclusion,
    verification: { mode, passed: true, at: String(verification.data.at), criterion: String(verification.data.criterion) },
  };
  deps.db
    .prepare('INSERT INTO case_lessons (id, source_case_id, title, domain, tags_json, data_json, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('LES'), id, input.title?.trim() || row.origin.title, row.origin.domain, JSON.stringify(lessonTags(row)), JSON.stringify(lesson), `${account.displayName}（${account.title}）`, deps.clock().toISOString());
}

/** Lessons whose rule or objects overlap with this case. A shared cause tag alone is too weak to suggest one. */
function similarLessons(deps: Deps, account: Account, row: CaseRow): Lesson[] {
  const mine = new Set(lessonTags(row).filter((t) => !t.startsWith('cause:')));
  return (deps.db.prepare('SELECT * FROM case_lessons WHERE source_case_id <> ? ORDER BY confirmed_at DESC').all(row.id) as Row[])
    .map(rowToLesson)
    .filter((l) => canSee(account.role, l.domain) && l.tags.some((t) => mine.has(t)) && lessonStillValid(deps, l))
    .map(forReader);
}

/** A lesson from a case that was later reopened or flagged for review is no longer proven. */
function lessonStillValid(deps: Deps, lesson: Lesson): boolean {
  const source = deps.db.prepare('SELECT status, needs_review FROM cases WHERE id = ?').get(lesson.sourceCaseId) as Row | undefined;
  return !!source && source.status === 'verified' && Number(source.needs_review) === 0;
}

/** The tags are matching keys built from every object and cause of the source case, so they stay on the server. */
const forReader = (lesson: Lesson): Lesson => ({ ...lesson, tags: [] });

export function referenceLesson(deps: Deps, account: Account, id: string, lessonId: string): void {
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  if (row.status === 'verified') fail(409, '事项已验证，请先重新开启');
  const found = deps.db.prepare('SELECT * FROM case_lessons WHERE id = ?').get(lessonId) as Row | undefined;
  const lesson = found ? rowToLesson(found) : null;
  if (!lesson || lesson.sourceCaseId === id || !canSee(account.role, lesson.domain)) return fail(404, '经验卡不存在');
  if (!lessonStillValid(deps, lesson)) return fail(409, '该经验所属事项已重新开启或需要复核，暂不能引用');
  if (entries.some((e) => e.kind === 'reference' && e.data.lessonId === lessonId)) fail(409, '该经验已引用');
  addEntry(deps, row, {
    kind: 'reference',
    domain: lesson.domain,
    author: personOf(account),
    title: `引用经验：${lesson.title}`,
    body: `适用条件：${lesson.conditions}\n措施：${lesson.measure}\n历史结论：${lesson.conclusion === 'effective' ? '有效' : '无效'}（${lesson.result}）`,
    pending: [`经验来自历史事项 ${lesson.sourceCaseId}，适用条件是否满足需对照本次证据核查；它不替代本次核查`],
    data: { lessonId, sourceCaseId: lesson.sourceCaseId },
  });
}

// --- Views -----------------------------------------------------------------------------------------------------

function summaryFor(deps: Deps, account: Account, row: CaseRow, entries: StoredEntry[]): CaseSummary {
  const owner = deps.db.prepare('SELECT display_name, title FROM accounts WHERE id = ?').get(row.ownerId) as Row | undefined;
  const originVisible = canSee(account.role, row.origin.domain);
  const domains = unique([row.origin.domain, ...entries.map((e) => e.domain).filter((d): d is Domain => d !== 'executive')]).filter((d) => canSee(account.role, d));
  return {
    id: row.id,
    goal: originVisible ? row.goal : `跨部门协作事项 ${row.id}`,
    status: row.status,
    round: row.round,
    needsReview: row.needsReview,
    owner: { name: String(owner?.display_name ?? '—'), title: String(owner?.title ?? '') },
    origin: originVisible ? row.origin : null,
    originDomain: row.origin.domain,
    objects: row.objects.filter((o) => o.domains.some((d) => canSee(account.role, d))),
    domains,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listCases(deps: Deps, account: Account): CaseSummary[] {
  const ids = (deps.db.prepare('SELECT id FROM cases ORDER BY updated_at DESC').all() as Row[]).map((r) => String(r.id));
  const out: CaseSummary[] = [];
  for (const id of ids) {
    if (!canOpen(account, readCase(deps, id), loadEntries(deps, id))) continue;
    syncCase(deps, id);
    const row = readCase(deps, id);
    const entries = loadEntries(deps, id);
    if (canOpen(account, row, entries)) out.push(summaryFor(deps, account, row, entries));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function toEntry(deps: Deps, account: Account, entry: StoredEntry): CaseEntry {
  const data = { ...entry.data };
  if (entry.kind === 'evidence' && Array.isArray(data.eventIds)) {
    // Events are read now and redacted for this viewer; the case only keeps their ids.
    data.events = (data.eventIds as string[])
      .map((eventId) => getEvent(deps, eventId))
      .filter((e): e is AgentOSEvent => e !== null)
      .map((e) => redactEvent(deps, e, account.role));
  }
  return {
    id: entry.id,
    kind: entry.kind,
    domain: entry.domain,
    round: entry.round,
    author: entry.author,
    title: entry.title,
    body: entry.body,
    facts: entry.facts,
    pending: entry.pending,
    suggestions: entry.suggestions,
    artifacts: entry.artifacts,
    data,
    createdAt: entry.createdAt,
  };
}

export function caseDetail(deps: Deps, account: Account, id: string): CaseDetail {
  // Check access before anything is written: an outsider's request must not change a case.
  mustOpen(account, readCase(deps, id), loadEntries(deps, id));
  syncCase(deps, id);
  const row = readCase(deps, id);
  const entries = loadEntries(deps, id);
  mustOpen(account, row, entries);
  const visible = entries.filter(visibleTo(account));
  const tasks = visible
    .filter((e) => e.kind === 'action')
    .map((e) => getTask(deps.db, String(e.data.taskId)))
    .filter((t): t is Task => t !== null && canSee(account.role, t.domain));
  const involved = new Set<Scope>([row.origin.domain, ...entries.map((e) => e.domain)]);
  const agents: CaseAgentOption[] = deps.registry
    .agents()
    .filter((a) => !a.companyService && canUseAgent(account.role, a))
    .sort((a, b) => Number(involved.has(b.module)) - Number(involved.has(a.module)))
    .map((a) => ({ id: a.id, name: a.name, domain: a.module, description: a.description, starters: deps.registry.starters(a).slice(0, 3) }));
  const lessonRow = deps.db.prepare('SELECT * FROM case_lessons WHERE source_case_id = ?').get(id) as Row | undefined;
  const lesson = lessonRow ? rowToLesson(lessonRow) : null;
  // Only readings of objects this viewer can already see: an object hidden from the summary must not show up here.
  const shownObjects = summaryFor(deps, account, row, entries).objects;
  const live = liveReadings(deps, { origin: row.origin, objects: shownObjects }).filter((r) => canSee(account.role, r.domain));
  return {
    summary: summaryFor(deps, account, row, entries),
    entries: visible.map((e) => toEntry(deps, account, e)),
    hiddenEntries: entries.length - visible.length,
    tasks,
    candidates: candidatesFor(deps, account, row, entries),
    live,
    agents,
    lesson: lesson && canSee(account.role, lesson.domain) ? forReader(lesson) : null,
    similarLessons: similarLessons(deps, account, row),
    canManage: canManage(account, row),
    canAutoVerify: canManage(account, row) && row.status === 'verifying' && live.length > 0,
  };
}

