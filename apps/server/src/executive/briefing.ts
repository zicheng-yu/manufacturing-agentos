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

/** Payload fields that identify the same thing across modules. */
const LINK_FIELDS = ['materialCode', 'supplierName', 'supplier'];

function ruleFor(deps: Deps, signal: Signal): SignalRule | undefined {
  return deps.registry.module(signal.domain).signalRules.find((r) => r.id === signal.ruleId);
}

export function rankSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.lastAt.localeCompare(a.lastAt));
}

/** Find the same material, supplier or team showing up in signals of different modules. */
export function crossDomainLinks(deps: Deps, signals: Signal[]): string[] {
  const seen = new Map<string, Set<Domain>>();
  for (const signal of signals) {
    for (const event of signalEvents(deps, signal)) {
      for (const field of LINK_FIELDS) {
        const value = event.payload[field];
        if (typeof value !== 'string' || !value) continue;
        seen.set(value, (seen.get(value) ?? new Set()).add(signal.domain));
      }
    }
  }
  const links = [...seen]
    .filter(([, domains]) => domains.size >= 2)
    .map(([value, domains]) => `${value} 同时出现在${[...domains].map((d) => DOMAIN_LABELS[d]).join('、')}的信号中`);

  const activeDomains = new Set(signals.map((s) => s.domain));
  for (const signal of signals.filter((s) => s.ruleId === 'hr-team-attrition')) {
    const department = signal.title.replace('减员预警', '');
    const related = DEPARTMENT_DOMAIN[department];
    if (related && activeDomains.has(related)) links.push(`${department}减员预警与${DOMAIN_LABELS[related]}风险叠加，处置人手可能不足`);
  }
  return links;
}

export const briefingAgent: AgentDefinition = {
  id: 'executive.briefing',
  module: 'executive',
  name: '经营决策助手',
  description: '读取四个模块的态势、信号与共享记忆，给出今天最需要决定的事',
  instructions: [
    '你面向董事长。先用一句话概括全局态势，再列出今天最需要决定的事，最后用一两句话点出跨部门关联及其含义。',
    '「今天最需要决定的事」必须与业务数据中的同名清单一一对应：顺序、事项、建议负责人、建议完成时限都不得改动或合并，可以用更适合董事长阅读的话说明影响。',
  ].join('\n'),
  starters: ['今天最需要我决定的三件事是什么？', '各部门现在有什么风险？', '供应链和品质的问题有关联吗？'],
  context({ deps, account, now }) {
    const domains = domainsFor(account.role);
    const situations = domains.map((d) => computeSituation(deps, d));
    const signals = rankSignals(listSignals(deps, domains));
    const links = crossDomainLinks(deps, signals);

    // Most severe first, then the most urgent playbook, so root causes with short fuses lead.
    const urgent = [...signals].sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
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
      ],
      facts: [...signals.slice(0, 5).map((s) => `${DOMAIN_LABELS[s.domain]}信号：${s.title}`), ...links],
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
          ]
        : [],
    };
  },
};
