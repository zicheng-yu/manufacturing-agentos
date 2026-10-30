import { listEvents } from '../../core/events.ts';
import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate, keywordScore } from '../../core/util.ts';
import { isOverdue, listCapa, listComplaints, similarCases, type Complaint } from './data.ts';

const CONTAINMENT = '冻结同批次在库与在途品，筛查客户端库存，必要时临时加严出货检验';

function complaintLine(c: Complaint): string {
  return `${c.id} ${c.customer} ${c.product} 批次 ${c.batch}：${c.symptom}（类别：${c.category}，${c.status}${c.caseId ? `，关联案例 ${c.caseId}` : ''}）`;
}

/** An open complaint the question is about: by id, else by customer name plus a similar symptom. */
function findOpenComplaint(complaints: Complaint[], text: string): Complaint | undefined {
  const upper = text.toUpperCase();
  const open = complaints.filter((c) => c.status !== '已结案');
  return (
    complaints.find((c) => upper.includes(c.id)) ??
    open.find((c) => text.includes(c.customer) && keywordScore(text, c.symptom) >= 4) ??
    open.find((c) => keywordScore(text, c.symptom) >= 10)
  );
}

export const complaintAgent: AgentDefinition = {
  id: 'quality.complaint',
  module: 'quality',
  name: '客诉受理助手',
  description: '整理客诉现象，检索历史同类案例，给出围堵建议',
  instructions:
    '你负责客诉受理。先判断问题类别，再引用历史同类案例；围堵措施（冻结、筛查）与永久对策（历史案例的对策）分开写；根因在现场确认前一律标为待核。需要 8D 时建议使用 8D 改善助手。',
  starters: ['客户反馈中控屏间歇黑屏，FPC 金手指发黑', '偏光片起泡以前怎么解决的', '最近有哪些未结客诉？'],
  context({ db, input, history }) {
    // Follow-ups ("那现在先怎么围堵？") keep the earlier description in play.
    const query = [input, ...history.slice(-2)].join(' ');
    const matches = similarCases(db, query).slice(0, 3);
    const complaints = listComplaints(db);
    const open = complaints.filter((c) => c.status !== '已结案');
    const known = findOpenComplaint(complaints, query);
    const best = matches[0]?.case;
    return {
      headline: best ? `与历史案例 ${best.id}「${best.title}」最相似` : '案例库中未找到明显同类问题',
      blocks: [
        ...(known ? [{ title: '对应的未结客诉', lines: [`即 ${complaintLine(known)}`] }] : []),
        {
          title: '相似历史案例',
          lines: matches.length
            ? matches.map((m) => `${m.case.id} ${m.case.title}（${m.case.category}）：根因 ${m.case.rootCause}；永久对策 ${m.case.countermeasure}`)
            : ['无'],
        },
        { title: '围堵措施（通用）', lines: [CONTAINMENT] },
        { title: '未结客诉', lines: open.length ? open.map(complaintLine) : ['无'] },
      ],
      facts: [
        ...(known ? [`该问题即未结客诉 ${known.id}（${known.customer}，批次 ${known.batch}）`] : []),
        ...matches.map((m) => `${m.case.id}「${m.case.title}」历史根因：${m.case.rootCause}`),
      ],
      pending: best ? [`本次问题是否与 ${best.id} 同一根因，需现场拆解确认`] : ['问题类别需品质工程师判定'],
      suggestions: [
        `先围堵：${CONTAINMENT}`,
        ...(best ? [`永久对策参考 ${best.id}：${best.countermeasure.split('；')[0]}`] : ['收集不良样品与批次信息，安排失效分析']),
      ],
      artifacts: matches.length
        ? [
            {
              kind: 'table',
              title: '相似案例',
              columns: ['案例', '标题', '类别', '根因', '永久对策', '涉及供应商', '相似度'],
              rows: matches.map((m) => [m.case.id, m.case.title, m.case.category, m.case.rootCause, m.case.countermeasure, m.case.supplier, m.score]),
            },
          ]
        : [],
    };
  },
};

const DRAFT_WORDS = /8D|8d|起草|报告|草案/;

export const capaAgent: AgentDefinition = {
  id: 'quality.capa',
  module: 'quality',
  name: '8D 改善助手',
  description: '按 8D 框架整理问题、根因与对策，跟踪整改项',
  instructions:
    '你负责 8D 改善。起草 8D 时按 D1–D8 输出，内容以「8D 草案」为准：写着「待失效分析」的步骤照写，不得引用其他案例补全；只引用与本客诉同类的案例。没有指定客诉时，回答整改项与复发情况。',
  starters: ['为 CC-2610-12 起草 8D', '哪些整改项逾期了？', '同类异常复发应该怎么处理'],
  context({ db, now, input, history, deps }) {
    const today = isoDate(now);
    const due = (n: number) => isoDate(addDays(now, n));
    const complaints = listComplaints(db);
    const capa = listCapa(db);
    const text = [input, ...history.slice(-2)].join(' ');
    // Only draft an 8D when asked for one; otherwise answer about corrective actions in general.
    const complaint = DRAFT_WORDS.test(input) ? (findOpenComplaint(complaints, text) ?? complaints.find((c) => c.status !== '已结案')) : undefined;

    if (!complaint) {
      const overdue = capa.filter((c) => isOverdue(c, today));
      const recurrences = listEvents(deps, { domains: ['quality'], status: 'unresolved', limit: 50 }).filter((e) => e.type === 'defect_recurrence');
      return {
        headline: overdue.length ? `${overdue.length} 项整改逾期` : '没有逾期的整改项',
        blocks: [
          { title: '整改项', lines: capa.map((c) => `${c.id}（${c.complaintId}）${c.title}：${c.owner}，期限 ${c.due}，${isOverdue(c, today) ? '已逾期' : c.status}`) },
          { title: '同类异常复发', lines: recurrences.length ? recurrences.map((e) => e.summary) : ['无'] },
          {
            title: '复发的处理原则',
            lines: ['先围堵：' + CONTAINMENT, '对复发客诉启动 8D，核查历史对策为何没有闭环（是否执行、是否被供应商遵守）', '约谈相关供应商并决定是否追溯在库与在途批次'],
          },
        ],
        facts: [...overdue.map((c) => `${c.id} ${c.title} 已逾期（原定 ${c.due}，${c.owner}）`), ...recurrences.map((e) => e.title)],
        actions: overdue.map((c) => ({ title: `督办 ${c.id} ${c.title}`, owner: '品质经理', due: due(1) })),
        artifacts: [
          {
            kind: 'table',
            title: '8D 整改项',
            columns: ['编号', '客诉', '整改内容', '负责人', '期限', '状态'],
            rows: capa.map((c) => [c.id, c.complaintId, c.title, c.owner, c.due, isOverdue(c, today) ? '已逾期' : c.status]),
          },
        ],
      };
    }

    const match = similarCases(db, `${complaint.symptom} ${complaint.category}`, complaint.category).find(
      (m) => m.case.category === complaint.category || m.case.id === complaint.caseId,
    )?.case;
    const own = capa.filter((c) => c.complaintId === complaint.id);
    const rows: [string, string][] = [
      ['D1 成立小组', '品质经理牵头；成员：SQE、工艺、生产、供应商代表'],
      ['D2 问题描述', `${complaint.customer} ${complaint.product} 批次 ${complaint.batch}：${complaint.symptom}`],
      ['D3 临时围堵', CONTAINMENT],
      ['D4 根因', match ? `假设：同 ${match.id}，${match.rootCause}（待现场确认）` : '待失效分析'],
      ['D5 永久对策', match ? `参考 ${match.id}：${match.countermeasure}` : '根因确认后制定'],
      ['D6 验证', '对策导入后连续 3 批次跟踪，客户端零复发'],
      ['D7 预防再发', '更新 PFMEA 与控制计划，横向展开到同类产品'],
      ['D8 关闭', '客户确认后关闭，沉淀到品质案例库'],
    ];
    return {
      headline: `${complaint.id} 8D 草案`,
      blocks: [
        { title: '8D 草案', lines: rows.map(([k, v]) => `${k}：${v}`) },
        { title: '本客诉的整改项', lines: own.length ? own.map((c) => `${c.id} ${c.title}（${c.owner}，${c.due}，${isOverdue(c, today) ? '已逾期' : c.status}）`) : ['尚未建立'] },
      ],
      facts: [`${complaint.id} 来自 ${complaint.customer}，批次 ${complaint.batch}`, ...(match ? [`同类历史案例 ${match.id}：${match.title}`] : [])],
      pending: [match ? `D4 根因沿用 ${match.id} 的结论，需现场拆解确认` : 'D4 根因待失效分析'],
      actions: [
        { title: `${complaint.id} 冻结并追溯批次 ${complaint.batch}`, owner: '品质经理', due: due(1) },
        { title: `${complaint.id} 完成失效分析与根因确认`, owner: 'SQE', due: due(3) },
      ],
      artifacts: [{ kind: 'table', title: `${complaint.id} 8D 报告草案`, columns: ['步骤', '内容'], rows }],
    };
  },
};
