import { DOMAIN_LABELS, type Domain, type Signal } from '@agentos/shared';
import type { Deps } from '../core/deps.ts';
import { severityRank } from '../core/events.ts';
import type { AgentDefinition, SignalRule } from '../core/module.ts';
import { domainsFor } from '../core/roles.ts';
import { computeSituation, listSignals, signalEvents } from '../core/signals.ts';
import { addMinutes, isoDate } from '../core/util.ts';

const LEVEL_LABEL = { normal: '正常', watch: '关注', alert: '告警' } as const;

/** HR departments that correspond to another module, so attrition can be linked to that module's risks. */
const DEPARTMENT_DOMAIN: Record<string, Domain> = { 供应链部: 'supply', 品质部: 'quality', 智能物流部: 'logistics' };

/**
 * Payload fields that identify the same thing across modules: a material, a supplier, or a stop cause such as
 * 缺料待料 that production losses share with supply shortages and late line-side deliveries. A field may hold a list.
 */
const LINK_FIELDS = { materialCode: '共同物料', supplierName: '共同供应商', supplier: '共同供应商', causes: '共同原因标签' } as const;

export interface LinkEvidence {
  value: string;
  kind: string;
  sources: { domain: Domain; signalId: string; eventId: string; title: string }[];
  summary: string;
}

function ruleFor(deps: Deps, signal: Signal): SignalRule | undefined {
  return deps.registry.module(signal.domain).signalRules.find((r) => r.id === signal.ruleId);
}

export function rankSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.lastAt.localeCompare(a.lastAt));
}

/**
 * The same material, supplier or team showing up in signals of different modules, stated with the events that
 * show it, e.g. "FPC-1203：智能物流「入库暂存区积压 46 箱」；供应链「…缺料风险」".
 */
export function crossDomainEvidence(deps: Deps, signals: Signal[]): LinkEvidence[] {
  const seen = new Map<string, Omit<LinkEvidence, 'summary'>>();
  for (const signal of signals) {
    for (const event of signalEvents(deps, signal)) {
      for (const [field, kind] of Object.entries(LINK_FIELDS)) {
        const raw = event.payload[field];
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          if (typeof value !== 'string' || !value.trim()) continue;
          const key = `${kind}:${value.trim()}`;
          const link = seen.get(key) ?? { value: value.trim(), kind, sources: [] };
          if (!link.sources.some((s) => s.signalId === signal.id && s.eventId === event.id)) link.sources.push({ domain: signal.domain, signalId: signal.id, eventId: event.id, title: event.title });
          seen.set(key, link);
        }
      }
    }
  }
  const links: LinkEvidence[] = [...seen.values()]
    .filter((link) => new Set(link.sources.map((s) => s.domain)).size >= 2)
    .map((link) => ({ ...link, summary: `${link.value}：${[...new Map(link.sources.map((s) => [s.domain, s.title]))].map(([d, title]) => `${DOMAIN_LABELS[d]}「${title}」`).join('；')}（${link.kind}，关联不代表已验证因果）` }));

  const activeDomains = new Set(signals.map((s) => s.domain));
  for (const signal of signals.filter((s) => s.ruleId === 'hr-team-attrition')) {
    for (const event of signalEvents(deps, signal)) {
      const department = typeof event.payload.department === 'string' ? event.payload.department : '';
      const related = DEPARTMENT_DOMAIN[department];
      if (!related || !activeDomains.has(related) || links.some((l) => l.kind === '人员风险叠加' && l.value === department)) continue;
      const relatedSources = signals.filter((s) => s.domain === related).flatMap((s) => signalEvents(deps, s).map((e) => ({ domain: s.domain, signalId: s.id, eventId: e.id, title: e.title })));
      if (relatedSources.length) links.push({ value: department, kind: '人员风险叠加', sources: [{ domain: signal.domain, signalId: signal.id, eventId: event.id, title: event.title }, ...relatedSources], summary: `${department}减员预警与${DOMAIN_LABELS[related]}风险叠加，处置人手可能不足（需负责人核实）` });
    }
  }
  return links;
}

export function crossDomainLinks(deps: Deps, signals: Signal[]): string[] {
  return crossDomainEvidence(deps, signals).map((link) => link.summary);
}

const DETAIL_FIELDS: [string, (v: unknown) => string][] = [
  ['coverDays', (v) => `可用 ${v} 天`],
  ['stockoutDate', (v) => `预计 ${v} 断料`],
  ['delayDays', (v) => `延迟 ${v} 天`],
  ['backlog', (v) => `积压 ${v} 箱`],
  ['bins', (v) => `其中 ${v} 箱为该物料`],
  ['materialCode', (v) => `物料 ${v}`],
  ['supplierName', (v) => `供应商 ${v}`],
  ['supplier', (v) => `涉及供应商 ${v}`],
  ['caseId', (v) => `同类历史案例 ${v}`],
  ['rootCause', (v) => `历史根因：${v}`],
  ['position', (v) => `岗位 ${v}`],
  ['lossBreakdown', (v) => `停机构成：${v}`],
];

/** A signal with the concrete figures from its events, so answers can cite them. */
export function signalDetail(deps: Deps, signal: Signal): string {
  const facts = new Set<string>();
  for (const event of signalEvents(deps, signal)) {
    for (const [field, render] of DETAIL_FIELDS) {
      const value = event.payload[field];
      if (value === undefined || value === null || value === '') continue;
      const fact = render(value);
      if (!signal.summary.includes(fact)) facts.add(fact);
    }
  }
  return `${DOMAIN_LABELS[signal.domain]}「${signal.title}」：${signal.summary}${facts.size ? `（${[...facts].join('，')}）` : ''}`;
}

export const briefingAgent: AgentDefinition = {
  id: 'executive.briefing',
  module: 'executive',
  name: '经营决策助手',
  description: '读取各模块的态势、信号与共享记忆，给出今天最需要决定的事',
  instructions: [
    '你面向董事长。先用一句话概括全局态势，再列出今天最需要决定的事，最后用一两句话点出跨部门关联及其含义。',
    '「今天最需要决定的事」必须与业务数据中的同名清单一一对应：顺序、事项、建议负责人、建议完成时限都不得改动或合并，可以用更适合董事长阅读的话说明影响。',
    '引用「信号明细」里的具体数字。跨部门关联区分共同实体、共同原因标签与人员风险叠加，只能表述证据支持的关联，不能把标签共现写成已确认因果；按关联证据表的信号与事件编号追溯。',
    '回答追问时同样以这些数据为准；只能先做一件事时，选清单的第 1 件并说明理由。',
  ].join('\n'),
  starters: ['今天最需要我决定的三件事是什么？', '各部门现在有什么风险？', '供应链和品质的问题有关联吗？'],
  startersByDataset: { official: ['今天最需要我决定的三件事是什么？', '各部门现在有什么风险？', '缺料和停机有什么关系？'] },
  context({ deps, account, now }) {
    const domains = domainsFor(account.role);
    const situations = domains.map((d) => computeSituation(deps, d));
    const signals = rankSignals(listSignals(deps, domains));
    const evidence = crossDomainEvidence(deps, signals);
    const links = evidence.map((link) => link.summary);

    // Most severe first, then what belongs on the chairman's desk (playbook weight), then the most urgent.
    const urgent = [...signals].sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        (ruleFor(deps, b)?.playbook.weight ?? 1) - (ruleFor(deps, a)?.playbook.weight ?? 1) ||
        (ruleFor(deps, a)?.playbook.dueHours ?? 24) - (ruleFor(deps, b)?.playbook.dueHours ?? 24) ||
        b.lastAt.localeCompare(a.lastAt),
    );
    const decisions = urgent.slice(0, 3).map((signal) => {
      const playbook = ruleFor(deps, signal)?.playbook;
      const due = addMinutes(now, (playbook?.dueHours ?? 24) * 60);
      return {
        signal,
        decision: playbook?.decision ?? `处置：${signal.title}`,
        impact: playbook?.impact ?? signal.summary,
        owner: playbook?.owner ?? `${DOMAIN_LABELS[signal.domain]}负责人`,
        dueHours: playbook?.dueHours ?? 24,
        due,
      };
    });

    const alerts = situations.filter((s) => s.level === 'alert').map((s) => s.title);
    const headline = alerts.length
      ? `${alerts.join('、')}处于告警，今天有 ${decisions.length} 件事需要决定`
      : signals.length
        ? `整体可控，有 ${signals.length} 条信号需要关注`
        : '各模块运行正常，今天没有必须决定的事项';

    return {
      headline,
      blocks: [
        {
          title: '全局态势',
          lines: situations.map((s) => `${s.title}：${LEVEL_LABEL[s.level]}，${s.headline}`),
        },
        {
          title: '今天最需要决定的事',
          lines: decisions.length
            ? decisions.map(
                (d, i) =>
                  `${i + 1}. ${d.decision}。影响：${d.impact}。建议负责人：${d.owner}。建议 ${d.dueHours} 小时内完成。依据：${d.signal.title}`,
              )
            : ['暂无'],
        },
        { title: '跨部门关联', lines: links.length ? links : ['未发现跨部门关联'] },
        { title: '信号明细', lines: signals.length ? signals.map((sig) => signalDetail(deps, sig)) : ['无活跃信号'] },
      ],
      facts: [...urgent.slice(0, 4).map((sig) => signalDetail(deps, sig)), ...links],
      pending: decisions.length ? ['建议负责人与完成时间为系统建议，需董事长确认'] : [],
      actions: decisions.map((d) => ({ title: d.decision.split('，')[0], owner: d.owner, due: isoDate(d.due) })),
      artifacts: decisions.length
        ? [
            {
              kind: 'table',
              title: '今日决策简报',
              columns: ['序号', '待决事项', '影响', '建议负责人', '建议完成时间', '依据信号'],
              rows: decisions.map((d, i) => [
                i + 1,
                d.decision,
                d.impact,
                d.owner,
                `${d.dueHours} 小时内（${isoDate(d.due)}）`,
                `${DOMAIN_LABELS[d.signal.domain]}：${d.signal.title}`,
              ]),
            },
            ...(evidence.length ? [{
              kind: 'table' as const,
              title: '跨部门关联证据',
              columns: ['关联对象', '关联类型', '部门', '依据信号', '原始事件', '事件标题'],
              rows: evidence.flatMap((link) => link.sources.map((source) => [link.value, link.kind, DOMAIN_LABELS[source.domain], source.signalId, source.eventId, source.title])),
              note: '同名实体或共同原因标签支持联合核查，不代表已确认因果；人员风险为待核影响。'
            }] : []),
          ]
        : [],
    };
  },
};
