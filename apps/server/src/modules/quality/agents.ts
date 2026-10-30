import { listEvents } from '../../core/events.ts';
import type { AgentContext, AgentDefinition } from '../../core/module.ts';
import { qualityDate, shiftDate } from './calendar.ts';
import { complaintTrend, isClosedComplaint, isOverdue, listCapa, listComplaints, similarCases, type Complaint } from './data.ts';

import { qualityQuery } from './query.ts';
import { syncOverdueEvents } from './tracking.ts';

const CONTAINMENT = '冻结同批次在库与在途品，筛查客户端库存，必要时临时加严出货检验';

function complaintLine(c: Complaint): string {
  return `${c.id} ${c.customer} ${c.product} 批次 ${c.batch}：${c.symptom}（类别：${c.category}，${c.status}${c.caseId ? `，关联案例 ${c.caseId}` : ''}）`;
}

function clarification(ids: string[], now: Date): AgentContext {
  return {
    headline: `未收录或未能唯一确定客诉：${ids.join('、') || '请指定客诉编号'}`,
    blocks: [], pending: ['请核实客诉或案例编号，避免把其他客诉的根因、批次和整改项带入本次处理'],
    actions: [{ title: `核实品质问题编号 ${ids.join('、') || '待补充'}`, owner: '品质经理', due: qualityDate(now) }],
  };
}

export const complaintAgent: AgentDefinition = {
  id: 'quality.complaint',
  module: 'quality',
  name: '客诉受理助手',
  description: '整理客诉现象，检索历史同类案例，给出围堵建议',
  instructions:
    '你负责客诉受理。只引用当前问题对应的历史案例；相似症状不代表同一客诉或同一根因，无匹配应直接说明。围堵措施与历史永久对策分开写，永久对策在本次根因核实后再考虑采用。根因与供应商责任在现场确认前一律标为待核。需要8D时建议使用8D改善助手。',
  starters: ['客户反馈中控屏间歇黑屏，FPC 金手指发黑', '偏光片起泡以前怎么解决的', '最近有哪些未结客诉？'],
  context({ db, now, input, history, deps }) {
    syncOverdueEvents(deps);
    const resolved = qualityQuery(db, input, history);
    if (resolved.missing.length || resolved.complaintIds.length > 1) return clarification(resolved.missing.length ? resolved.missing : resolved.complaintIds, now);
    const complaints = listComplaints(db);
    const open = complaints.filter((c) => !isClosedComplaint(c) && c.receivedAt <= qualityDate(now));
    if (/趋势|未结|有哪些客诉|哪些客诉|客诉概览/.test(input) && !resolved.complaintIds.length) {
      const trend = complaintTrend(db, qualityDate(now));
      return {
        headline: `${open.length} 起未结客诉，近7天新增 ${trend.current} 起`,
        blocks: [{ title: '未结客诉', lines: open.length ? open.map(complaintLine) : ['无'] }, { title: '趋势口径', lines: [`今天及前6天新增 ${trend.current} 起，前7天 ${trend.previous} 起，增减 ${trend.delta} 起；按客诉编号计数，排除未来日期和取消记录`] }],
        facts: [`近7天新增 ${trend.current} 起，前7天 ${trend.previous} 起`],
        artifacts: [{ kind: 'table', title: '近7天客诉趋势', columns: ['日期', '新增客诉'], rows: trend.daily.map((d) => [d.day, d.count]) }],
      };
    }
    const matches = similarCases(db, resolved.search).slice(0, 3);
    const known = resolved.complaint;
    const best = matches[0]?.case;
    return {
      headline: best ? `与历史案例 ${best.id}「${best.title}」最相似` : '案例库中未找到明显同类问题',
      blocks: [
        ...(known ? [{ title: '对应客诉（状态以记录为准）', lines: [`${resolved.identified ? '已指定' : '可能对应，身份待核'}：${complaintLine(known)}`] }] : []),
        {
          title: '相似历史案例',
          lines: matches.length
            ? matches.map((m) => `${m.case.id} ${m.case.title}（${m.case.category}）：历史根因 ${m.case.rootCause}；历史永久对策 ${m.case.countermeasure}；本次适用性待核`)
            : ['无'],
        },
        { title: known && isClosedComplaint(known) ? '结案复盘提示' : '围堵措施（通用）', lines: known && isClosedComplaint(known) ? ['该客诉已结案，本次仅复盘历史信息，不生成新的围堵或冻结任务'] : [CONTAINMENT] },
      ],
      facts: [
        ...(known && resolved.identified ? [`指定客诉 ${known.id}（${known.customer}，批次 ${known.batch}，${known.status}）`] : []),
        ...matches.map((m) => `${m.case.id}「${m.case.title}」历史根因：${m.case.rootCause}`),
      ],
      pending: [...(best ? [`本次问题是否与 ${best.id} 同一根因，需现场拆解确认`] : ['未检索到足够相似的历史案例，需收集批次、样品和复现条件后由品质工程师判定']), ...(known && !resolved.identified ? [`可能对应 ${known.id}，请核实客户、批次与客诉身份`] : [])],
      suggestions: known && isClosedComplaint(known) ? ['复盘已结案信息；如发现新的异常，应另行登记新客诉并核实关联'] : [
        `先围堵：${CONTAINMENT}`,
        ...(best ? [`本次根因核实后，永久对策可参考 ${best.id}：${best.countermeasure.split('；')[0]}`] : ['收集不良样品与批次信息，安排失效分析']),
      ],
      artifacts: matches.length
        ? [
            {
              kind: 'table',
              title: '相似案例',
              columns: ['案例', '标题', '类别', '历史根因（本次待核）', '历史永久对策', '历史供应商', '匹配分（非概率）', '命中线索'],
              rows: matches.map((m) => [m.case.id, m.case.title, m.case.category, m.case.rootCause, m.case.countermeasure, m.case.supplier, m.score, m.terms.join('、') || '症状文本重合']),
            },
          ]
        : [],
    };
  },
};

const DRAFT_WORDS = /起草|生成|编写|草案|写一份|做一份/;

function requestedSteps(input: string): number[] {
  const explicit = [...new Set([...input.matchAll(/\bD([1-8])\b/gi)].map((m) => Number(m[1])))];
  if (explicit.length) return explicit;
  if (DRAFT_WORDS.test(input) && /8d/i.test(input)) return [];
  if (/根因|失效分析/.test(input)) return [4];
  if (/验证/.test(input)) return [6];
  return [];
}

export const capaAgent: AgentDefinition = {
  id: 'quality.capa',
  module: 'quality',
  name: '8D 改善助手',
  description: '按 8D 框架整理问题、根因与对策，跟踪整改项',
  instructions:
    '你负责8D改善。起草必须唯一确定本次客诉，编号未收录或不明确时要求核实，不得选择其他客诉代写。按D1–D8输出，以「8D草案」为准；写着「待失效分析」的步骤照写，不得用其他案例补全。本次根因与责任需独立核实，D6是拟定验证计划，不是验证已通过。仅查询整改项时不代写报告。',
  starters: ['为 CC-2610-12 起草 8D', '哪些整改项逾期了？', '同类异常复发应该怎么处理'],
  context({ db, now, input, history, deps }) {
    syncOverdueEvents(deps);
    const today = qualityDate(now);
    const due = (n: number) => shiftDate(today, n);
    const complaints = listComplaints(db);
    const capa = listCapa(db);
    const resolved = qualityQuery(db, input, history);
    if (resolved.missing.length || resolved.complaintIds.length > 1) return clarification(resolved.missing.length ? resolved.missing : resolved.complaintIds, now);
    const steps = requestedSteps(input);
    const wantsDraft = steps.length > 0 || DRAFT_WORDS.test(input) || (/8d/i.test(input) && resolved.complaintIds.length === 1 && !/逾期|整改项|督办|进度/.test(input));
    const complaint = wantsDraft ? resolved.complaint : undefined;
    if (wantsDraft && !complaint) {
      return {
        headline: '请先指定要起草8D的客诉编号',
        blocks: [{ title: '可核实的未结客诉', lines: complaints.filter((c) => !isClosedComplaint(c)).map(complaintLine) }],
        pending: ['没有唯一确定本次客诉，不选择其他客诉代写8D'],
      };
    }

    if (!complaint) {
      const relevant = resolved.complaint ? capa.filter((c) => c.complaintId === resolved.complaint!.id) : capa;
      const overdue = relevant.filter((c) => isOverdue(c, today));
      const completed = relevant.filter((c) => c.status === '已完成');
      const recurrences = listEvents(deps, { domains: ['quality'], status: 'unresolved', limit: 50 }).filter((e) => e.type === 'defect_recurrence' && (!resolved.complaint || e.payload.complaintId === resolved.complaint.id));
      return {
        headline: resolved.complaint ? relevant.length ? `${resolved.complaint.id} 整改已完成 ${completed.length}/${relevant.length} 项，逾期 ${overdue.length} 项` : `${resolved.complaint.id} 尚未建立整改台账` : overdue.length ? `${overdue.length} 项整改逾期` : '没有逾期的整改项',
        blocks: [
          { title: '整改项', lines: relevant.map((c) => `${c.id}（${c.complaintId}）${c.title}：${c.owner}，期限 ${c.due}，${isOverdue(c, today) ? '已逾期' : c.status}`) },
          { title: '同类异常复发', lines: recurrences.length ? recurrences.map((e) => e.summary) : ['无'] },
          {
            title: '复发的处理原则',
            lines: ['先围堵：' + CONTAINMENT, '对复发客诉启动 8D，核查历史对策为何没有闭环（是否执行、是否被供应商遵守）', '约谈相关供应商并决定是否追溯在库与在途批次'],
          },
        ],
        facts: [...(resolved.complaint ? [`${resolved.complaint.id} 已建档整改 ${relevant.length} 项，已完成 ${completed.length} 项；建档和完成状态不等同于8D根因已验证`] : []), ...overdue.map((c) => `${c.id} ${c.title} 已逾期（原定 ${c.due}，${c.owner}）`), ...recurrences.map((e) => e.title)],
        pending: resolved.complaint && !relevant.length ? ['本客诉尚未建立整改台账；草案或普通待办不会自动成为已建档整改项'] : [],
        actions: overdue.map((c) => ({ title: `督办 ${c.id} ${c.title}`, owner: '品质经理', due: due(1) })),
        artifacts: [
          {
            kind: 'table',
            title: '8D 整改项',
            columns: ['编号', '客诉', '整改内容', '负责人', '期限', '状态'],
            rows: relevant.map((c) => [c.id, c.complaintId, c.title, c.owner, c.due, isOverdue(c, today) ? '已逾期' : c.status]),
          },
        ],
      };
    }

    const match = similarCases(db, complaint.symptom, complaint.category).find(
      (m) => m.case.id === complaint.caseId || (m.specific && m.case.category === complaint.category),
    )?.case;
    const own = capa.filter((c) => c.complaintId === complaint.id);
    const rows: [string, string][] = [
      ['D1 成立小组', '建议品质经理牵头，拟邀请SQE、工艺、生产和供应商代表；实际成员待确认'],
      ['D2 问题描述', `${complaint.customer} ${complaint.product} 批次 ${complaint.batch}：${complaint.symptom}`],
      ['D3 临时围堵', CONTAINMENT],
      ['D4 根因', match ? `待核假设：参考 ${match.id} 的历史根因「${match.rootCause}」；本次需独立失效分析，不视为已确认` : '待失效分析'],
      ['D5 永久对策', match ? `仅在本次根因验证成立后参考 ${match.id}：${match.countermeasure}` : '根因确认后制定'],
      ['D6 验证', '拟在对策导入后连续3批次跟踪，核查是否复发；实际结果待验证'],
      ['D7 预防再发', '拟更新 PFMEA 与控制计划，核实同类产品的横向展开范围'],
      ['D8 关闭', '客户确认后关闭，沉淀到品质案例库'],
    ];
    const focus = steps.length ? rows.filter((_, i) => steps.includes(i + 1)) : rows;
    const stepActions = [
      { title: `${complaint.id} 确认8D小组成员与分工`, owner: '品质经理', due: due(1) },
      { title: `${complaint.id} 核实问题描述、批次与样品信息`, owner: '品质经理', due: due(1) },
      { title: `${complaint.id} 冻结并追溯批次 ${complaint.batch}`, owner: '品质经理', due: due(1) },
      { title: `${complaint.id} 完成失效分析与根因确认`, owner: 'SQE', due: due(3) },
      { title: `${complaint.id} 根因验证成立后制定永久对策`, owner: '品质经理', due: due(3) },
      { title: `${complaint.id} 确认验证计划并收集实际结果`, owner: '品质经理', due: due(5) },
      { title: `${complaint.id} 核实PFMEA与控制计划横向展开范围`, owner: '品质经理', due: due(7) },
      { title: `${complaint.id} 核查整改、验证与客户确认后再申请关闭`, owner: '品质经理', due: due(7) },
    ];
    return {
      headline: `${complaint.id} ${isClosedComplaint(complaint) ? '已结案复盘' : steps.length ? steps.map((s) => `D${s}`).join('/') : '8D'}草案`,
      blocks: [
        { title: '本次客诉', lines: [complaintLine(complaint)] },
        { title: '8D 草案', lines: focus.map(([k, v]) => `${k}：${v}`) },
        { title: '本客诉的整改项', lines: own.length ? own.map((c) => `${c.id} ${c.title}（${c.owner}，${c.due}，${isOverdue(c, today) ? '已逾期' : c.status}）`) : ['尚未建立'] },
      ],
      facts: [`${complaint.id} 来自 ${complaint.customer}，批次 ${complaint.batch}`, ...(match ? [`同类历史案例 ${match.id}：${match.title}`] : [])],
      pending: [match ? `D4 只参考 ${match.id} 的历史结论，本次根因待独立失效分析确认` : 'D4 根因待失效分析', '草案和本轮待办不等于已建档整改项；确认事项、负责人和截止日期后建立整改台账，才会纳入持续逾期跟踪'],
      actions: isClosedComplaint(complaint) ? [] : steps.length ? steps.map((s) => stepActions[s - 1]) : [
        { title: `${complaint.id} 冻结并追溯批次 ${complaint.batch}`, owner: '品质经理', due: due(1) },
        { title: `${complaint.id} 完成失效分析与根因确认`, owner: 'SQE', due: due(3) },
      ],
      artifacts: [{ kind: 'table', title: `${complaint.id} ${steps.length ? steps.map((s) => `D${s}`).join('/') : '8D 报告'}草案`, columns: ['步骤', '内容'], rows: focus }],
    };
  },
};
