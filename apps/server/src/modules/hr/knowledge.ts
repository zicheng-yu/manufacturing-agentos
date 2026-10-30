import type { KnowledgeVersion, PolicyCitation } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { isoDate, keywordScore, newId, normalizeText } from '../../core/util.ts';
import { transaction, type DB, type Row } from '../../db.ts';

export const IMPORT_LEGACY_POLICIES = `
  INSERT OR IGNORE INTO hr_knowledge_documents (id, kind) SELECT id, 'policy' FROM hr_policies;
  INSERT OR IGNORE INTO hr_knowledge_versions
    (id, document_id, version, revision, status, title, category, keywords, content, scope, published_by, published_at)
    SELECT id || '-v1', id, 1, 1, 'published', title, category, keywords, content, '全体员工（演示制度）', '演示制度导入', 'legacy'
    FROM hr_policies WHERE NOT EXISTS (SELECT 1 FROM hr_knowledge_versions v WHERE v.document_id = hr_policies.id);
`;

export const KNOWLEDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hr_knowledge_documents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('policy', 'faq')),
    archived INTEGER NOT NULL DEFAULT 0,
    source_request_id TEXT REFERENCES hr_requests(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS hr_knowledge_versions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES hr_knowledge_documents(id),
    version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('draft', 'published')),
    title TEXT NOT NULL, category TEXT NOT NULL, keywords TEXT NOT NULL,
    content TEXT NOT NULL, scope TEXT NOT NULL, effective_from TEXT, effective_to TEXT,
    published_by TEXT, published_at TEXT,
    UNIQUE(document_id, version)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS hr_one_knowledge_draft ON hr_knowledge_versions(document_id) WHERE status = 'draft';
  ${IMPORT_LEGACY_POLICIES}
`;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const date = new Date(s + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}, '日期无效');
export const DraftFields = z.object({
  title: z.string().trim().min(2).max(160), category: z.string().trim().min(1).max(60),
  keywords: z.string().trim().max(2000).default(''), content: z.string().trim().min(5).max(20000),
  scope: z.string().trim().min(1).max(200), effectiveFrom: Day, effectiveTo: Day.nullable().default(null),
}).strict();
export const CreateKnowledge = DraftFields.extend({
  kind: z.enum(['policy', 'faq']), documentId: z.string().max(80).optional(), sourceRequestId: z.string().max(80).optional(),
}).refine((v) => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, '失效日期须晚于生效日期');
export const UpdateKnowledge = DraftFields.extend({ revision: z.number().int().positive() })
  .refine((v) => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, '失效日期须晚于生效日期');

const SELECT_VERSIONS = `SELECT v.*, d.kind, d.archived, d.source_request_id FROM hr_knowledge_versions v
  JOIN hr_knowledge_documents d ON d.id = v.document_id`;

function fromRow(r: Row): KnowledgeVersion {
  return {
    id: String(r.id), documentId: String(r.document_id), version: Number(r.version), revision: Number(r.revision),
    kind: r.kind as KnowledgeVersion['kind'], status: r.status as KnowledgeVersion['status'],
    title: String(r.title), category: String(r.category), keywords: String(r.keywords), content: String(r.content), scope: String(r.scope),
    effectiveFrom: r.effective_from ? String(r.effective_from) : null, effectiveTo: r.effective_to ? String(r.effective_to) : null,
    publishedBy: r.published_by ? String(r.published_by) : null,
    publishedAt: r.published_at && r.published_at !== 'legacy' ? String(r.published_at) : null,
    archived: Boolean(r.archived), sourceRequestId: r.source_request_id ? String(r.source_request_id) : null,
  };
}

export function listKnowledge(db: DB): KnowledgeVersion[] {
  return (db.prepare(SELECT_VERSIONS + ' ORDER BY d.id, v.version DESC').all() as Row[]).map(fromRow);
}

export function activeKnowledge(db: DB, now: Date): KnowledgeVersion[] {
  const today = isoDate(now);
  const latest = new Map<string, KnowledgeVersion>();
  for (const version of listKnowledge(db)) {
    if (version.archived || version.status !== 'published' || (version.effectiveFrom && version.effectiveFrom > today)) continue;
    // Choose the newest effective revision first; expiration must not resurrect an older policy.
    if (!latest.has(version.documentId)) latest.set(version.documentId, version);
  }
  return [...latest.values()].filter((v) => !v.effectiveTo || v.effectiveTo > today);
}

function getVersion(db: DB, id: string): KnowledgeVersion {
  const row = db.prepare(SELECT_VERSIONS + ' WHERE v.id = ?').get(id) as Row | undefined;
  if (!row) throw new HTTPException(404, { message: '知识版本不存在' });
  return fromRow(row);
}

export function createKnowledgeDraft(db: DB, raw: z.infer<typeof CreateKnowledge>): KnowledgeVersion {
  const input = CreateKnowledge.parse(raw);
  return transaction(db, () => {
    let documentId = input.documentId;
    if (documentId) {
      const versions = listKnowledge(db).filter((v) => v.documentId === documentId);
      if (!versions.length) throw new HTTPException(404, { message: '制度不存在' });
      if (versions[0].archived || versions.some((v) => v.status === 'draft')) throw new HTTPException(409, { message: '请先处理已有草稿或恢复已停用制度' });
      if (versions[0].kind !== input.kind || input.sourceRequestId) throw new HTTPException(400, { message: '修订不能改变知识类型或来源' });
    } else {
      if (input.sourceRequestId) {
        const request = db.prepare('SELECT r.status, l.answer FROM hr_requests r JOIN hr_request_links l ON l.request_id = r.id WHERE r.id = ?').get(input.sourceRequestId) as Row | undefined;
        if (input.kind !== 'faq' || request?.status !== '已解决' || !String(request?.answer ?? '').trim()) {
          throw new HTTPException(400, { message: '仅已解决且有答复的服务请求可整理为 FAQ' });
        }
      }
      documentId = newId(input.kind === 'faq' ? 'FAQ' : 'POL');
      db.prepare('INSERT INTO hr_knowledge_documents (id, kind, source_request_id) VALUES (?, ?, ?)').run(documentId, input.kind, input.sourceRequestId ?? null);
    }
    const version = Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS n FROM hr_knowledge_versions WHERE document_id = ?').get(documentId) as Row).n) + 1;
    const id = documentId + '-v' + version;
    db.prepare(`INSERT INTO hr_knowledge_versions (id, document_id, version, revision, status, title, category, keywords, content, scope, effective_from, effective_to)
      VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?)`).run(id, documentId, version, input.title, input.category, input.keywords, input.content, input.scope, input.effectiveFrom, input.effectiveTo);
    return getVersion(db, id);
  });
}

export function updateKnowledgeDraft(db: DB, id: string, raw: z.infer<typeof UpdateKnowledge>): KnowledgeVersion {
  const input = UpdateKnowledge.parse(raw);
  const version = getVersion(db, id);
  if (version.status !== 'draft' || version.archived) throw new HTTPException(409, { message: '已发布版本不可直接修改，请新建修订草稿' });
  const result = db.prepare(`UPDATE hr_knowledge_versions SET title = ?, category = ?, keywords = ?, content = ?, scope = ?, effective_from = ?, effective_to = ?, revision = revision + 1
    WHERE id = ? AND revision = ? AND status = 'draft'`).run(input.title, input.category, input.keywords, input.content, input.scope, input.effectiveFrom, input.effectiveTo, id, input.revision);
  if (!result.changes) throw new HTTPException(409, { message: '草稿已被更新，请刷新后再编辑' });
  return getVersion(db, id);
}

export function publishKnowledge(db: DB, id: string, revision: number, publisher: string, now: Date): KnowledgeVersion {
  return transaction(db, () => {
    const draft = getVersion(db, id);
    if (draft.status !== 'draft' || draft.archived || draft.revision !== revision) throw new HTTPException(409, { message: '草稿已变化或不可发布，请刷新后重新审核' });
    if (draft.effectiveTo && draft.effectiveTo <= isoDate(now)) throw new HTTPException(400, { message: '不能发布已失效的制度' });
    const last = listKnowledge(db).find((v) => v.documentId === draft.documentId && v.status === 'published');
    if (last?.effectiveFrom && draft.effectiveFrom! < last.effectiveFrom) throw new HTTPException(400, { message: '新版本的生效日期不能早于上一已发布版本' });
    if (draft.sourceRequestId) {
      const request = db.prepare('SELECT status FROM hr_requests WHERE id = ?').get(draft.sourceRequestId) as Row | undefined;
      if (request?.status !== '已解决') throw new HTTPException(409, { message: '来源请求尚未解决，请先核实答复' });
    }
    db.prepare(`UPDATE hr_knowledge_versions SET status = 'published', published_by = ?, published_at = ?, revision = revision + 1 WHERE id = ?`).run(publisher, now.toISOString(), id);
    return getVersion(db, id);
  });
}

export function archiveKnowledge(db: DB, documentId: string, archived: boolean): void {
  const result = db.prepare('UPDATE hr_knowledge_documents SET archived = ? WHERE id = ?').run(archived ? 1 : 0, documentId);
  if (!result.changes) throw new HTTPException(404, { message: '制度不存在' });
}

export interface KnowledgeSection extends PolicyCitation { text: string; keywords: string; category: string; }

export function knowledgeSections(versions: KnowledgeVersion[]): KnowledgeSection[] {
  return versions.flatMap((v) => {
    const sections = v.content.split(/\n\s*\n|\n/).flatMap((p) => {
      const chunks: string[] = [];
      for (let i = 0; i < p.trim().length; i += 800) chunks.push(p.trim().slice(i, i + 800));
      return chunks;
    }).filter(Boolean);
    return sections.map((text, i) => ({
      sourceId: v.id + ':s' + (i + 1), documentId: v.documentId, title: v.title, version: v.version,
      section: i + 1, kind: v.kind, text, quote: text, scope: v.scope, effectiveFrom: v.effectiveFrom,
      keywords: v.keywords, category: v.category,
    }));
  });
}

export function questionKey(value: string): string {
  return normalizeText(value).replace(/^(你好|请问|您好|想问一下|问一下)/, '');
}

export function matchingFaqs(versions: KnowledgeVersion[], question: string): KnowledgeVersion[] {
  const key = questionKey(question);
  return versions.filter((v) => v.kind === 'faq' && [v.title, ...v.keywords.split(/[\n；;]+/)].some((q) => questionKey(q) === key));
}

export function retrieveSections(versions: KnowledgeVersion[], question: string): KnowledgeSection[] {
  return knowledgeSections(versions).map((section) => ({ section, score: keywordScore(question, section.title + ' ' + section.keywords + ' ' + section.text) }))
    .sort((a, b) => b.score - a.score || a.section.sourceId.localeCompare(b.section.sourceId))
    .slice(0, 24).map(({ section }) => section);
}
