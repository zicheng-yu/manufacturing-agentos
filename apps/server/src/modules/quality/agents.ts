import type { AgentDefinition } from '../../core/module.ts';
import { addDays, isoDate } from '../../core/util.ts';
import { isOverdue, listCapa, listComplaints, similarCases, type Complaint } from './data.ts';

function findComplaint(complaints: Complaint[], input: string): Complaint | undefined {
  const upper = input.toUpperCase();
  return complaints.find((c) => upper.includes(c.id)) ?? complaints.find((c) => c.status !== '已结案');
}

export const complaintAgent: AgentDefinition = {
  id: 'quality.complaint',
  module: 'quality',
  name: '客诉受理助手',
  description: '整理客诉现象，检索历史同类案例，给出围堵建议',
  instructions: '你负责客诉受理。先判断问题类别，再引用历史同类案例的根因与对策；根因在现场确认前一律标为待核。',
  starters: ['客户反馈中控屏间歇黑屏，FPC 金手指发黑', '最近有哪些未结客诉？', '偏光片起泡以前怎么解决的'],
  context({ db, input }) {
    const matches = similarCases(db, input).slice(0, 3);
    const open = listComplaints(db).filter((c) => c.status !== '已结案');
    const best = matches[0]?.case;
    return {
      headline: best ? `与历史案例 ${best.id}「${best.title}」最相似` : '案例库中未找到明显同类问题',
      blocks: [
        {
          title: '相似历史案例',
          lines: matches.length
            ? matches.map((m) => `${m.case.id} ${m.case.title}（${m.case.category}）：根因 ${m.case.rootCause}；对策 ${m.case.countermeasure}`)
            : ['无'],
        },
        { title: '未结客诉', lines: open.map((c) => `${c.id} ${c.customer} ${c.product}：${c.symptom}（${c.status}）`) },
      ],
      facts: matches.map((m) => `${m.case.id}「${m.case.title}」历史根因：${m.case.rootCause}`),
      pending: best ? [`本次问题是否与 ${best.id} 同一根因，需现场拆解确认`] : ['问题类别需品质工程师判定'],
      suggestions: best
        ? [`参照 ${best.id} 先做围堵：${best.countermeasure.split('；')[0]}`, `追溯同批次在库与在途数量`]
        : ['收集不良样品与批次信息，安排失效分析'],
      artifacts: matches.length
        ? [
            {
              kind: 'table',
              title: '相似案例',
              columns: ['案例', '标题', '类别', '根因', '对策', '涉及供应商', '相似度'],
              rows: matches.map((m) => [m.case.id, m.case.title, m.case.category, m.case.rootCause, m.case.countermeasure, m.case.supplier, m.score]),
            },
          ]
        : [],
    };
  },
};

export const capaAgent: AgentDefinition = {
  id: 'quality.capa',
  module: 'quality',
  name: '8D 改善助手',
  description: '按 8D 框架整理问题、根因与对策，跟踪整改项',
  instructions: '你负责 8D 改善。按 D1–D8 输出，D4 根因引用历史案例时标为假设，整改项写清负责人和期限。',
  starters: ['为 CC-2610-09 起草 8D', '哪些整改项逾期了？', '同类异常复发应该怎么处理'],
  context({ db, now, input }) {
    const today = isoDate(now);
    const complaints = listComplaints(db);
    const complaint = findComplaint(complaints, input);
    const capa = listCapa(db);
    const overdue = capa.filter((c) => isOverdue(c, today));
    const due = (n: number) => isoDate(addDays(now, n));
    if (!complaint) {
      return {
        headline: '当前没有处理中的客诉',
        blocks: [{ title: '整改项', lines: capa.map((c) => `${c.id} ${c.title}（${c.owner}，${c.due}，${c.status}）`) }],
      };
    }
    const match = similarCases(db, `${complaint.symptom} ${complaint.category}`, complaint.category)[0]?.case;
    const rows: [string, string][] = [
      ['D1 成立小组', '品质经理牵头；成员：SQE、工艺、生产、供应商代表'],
      ['D2 问题描述', `${complaint.customer} ${complaint.product} 批次 ${complaint.batch}：${complaint.symptom}`],
      ['D3 临时围堵', '冻结同批次在库品，追溯在途批次并对客户端库存做筛选'],
      ['D4 根因（假设）', match ? `参照 ${match.id}：${match.rootCause}` : '待失效分析'],
      ['D5 永久对策', match ? match.countermeasure : '根因确认后制定'],
      ['D6 验证', '对策导入后连续 3 批次跟踪，客户端零复发'],
      ['D7 预防再发', '更新 PFMEA 与控制计划，横向展开到同类产品'],
      ['D8 关闭', '客户确认后关闭，沉淀到品质案例库'],
    ];
    return {
      headline: `${complaint.id} 8D 草案`,
      blocks: [
        { title: '8D 草案', lines: rows.map(([k, v]) => `${k}：${v}`) },
        { title: '逾期整改项', lines: overdue.length ? overdue.map((c) => `${c.id} ${c.title}（${c.owner}，原定 ${c.due}）`) : ['无'] },
      ],
      facts: [`${complaint.id} 来自 ${complaint.customer}，批次 ${complaint.batch}`],
      pending: [match ? `D4 根因沿用 ${match.id} 的结论，需现场拆解确认` : 'D4 根因待失效分析'],
      actions: [
        { title: `${complaint.id} 冻结并追溯批次 ${complaint.batch}`, owner: '品质经理', due: due(1) },
        { title: `${complaint.id} 完成失效分析与根因确认`, owner: 'SQE', due: due(3) },
        ...overdue.map((c) => ({ title: `督办 ${c.id} ${c.title}`, owner: '品质经理', due: due(1) })),
      ],
      artifacts: [{ kind: 'table', title: `${complaint.id} 8D 报告草案`, columns: ['步骤', '内容'], rows }],
    };
  },
};
