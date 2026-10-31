// AGV dispatch tasks from the official pack, judged against 《工厂智能物流管理制度》 2.6 (task execution ≥ 95%).
import type { Deps } from '../../core/deps.ts';
import type { AgentDefinition } from '../../core/module.ts';
import { syncStateAlerts } from '../../core/state-alerts.ts';
import { percent, round } from '../../core/util.ts';
import type { DB, Row } from '../../db.ts';
import { cite, num, officialTable } from '../../seed/official.ts';

/** On-time target for AGV tasks from the logistics regulation's KPI table. */
export const AGV_TARGET = 0.95;

export const AGV_SCHEMA = `
  CREATE TABLE IF NOT EXISTS logistics_agv_tasks (
    id TEXT PRIMARY KEY, issued_at TEXT NOT NULL, origin TEXT NOT NULL, dest TEXT NOT NULL, load_kg REAL, path_m REAL,
    duration_s REAL, wait_s REAL, battery_pct REAL, agv TEXT NOT NULL, timeout INTEGER NOT NULL
  );`;

export function seedAgv(db: DB): void {
  const insert = db.prepare(
    `INSERT INTO logistics_agv_tasks (id, issued_at, origin, dest, load_kg, path_m, duration_s, wait_s, battery_pct, agv, timeout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of officialTable('12_AGV调度任务')) {
    insert.run(r['任务号'], r['下发时间'], r['起始点'], r['目的点'], num(r['载重(kg)']), num(r['路径长度(m)']), num(r['实际耗时(s)']), num(r['等待时长(s)']), num(r['电量消耗(%)']), r['执行的AGV'], r['是否超时'] === '是' ? 1 : 0);
  }
}

interface Task {
  id: string;
  issuedAt: string;
  origin: string;
  dest: string;
  waitS: number;
  durationS: number;
  agv: string;
  timeout: boolean;
}

function listTasks(db: DB): Task[] {
  return (db.prepare('SELECT * FROM logistics_agv_tasks ORDER BY issued_at').all() as Row[]).map((r) => ({
    id: String(r.id),
    issuedAt: String(r.issued_at),
    origin: String(r.origin),
    dest: String(r.dest),
    waitS: Number(r.wait_s ?? 0),
    durationS: Number(r.duration_s ?? 0),
    agv: String(r.agv),
    timeout: Number(r.timeout) === 1,
  }));
}

export function hasAgv(db: DB): boolean {
  return Boolean(db.prepare('SELECT 1 FROM logistics_agv_tasks LIMIT 1').get());
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function agvSummary(db: DB) {
  const tasks = listTasks(db);
  // Same origin and destination is a dispatch data error, not a trip; keep it out of the rates and report it.
  const invalid = tasks.filter((t) => t.origin === t.dest);
  const valid = tasks.filter((t) => t.origin !== t.dest);
  const group = <K extends string>(key: (t: Task) => K) => {
    const map = new Map<K, Task[]>();
    for (const t of valid) map.set(key(t), [...(map.get(key(t)) ?? []), t]);
    return [...map].map(([k, ts]) => ({ key: k, tasks: ts.length, timeouts: ts.filter((t) => t.timeout).length, rate: ts.filter((t) => t.timeout).length / ts.length, wait: round(avg(ts.map((t) => t.waitS)), 0) }));
  };
  const byAgv = group((t) => t.agv).sort((a, b) => b.rate - a.rate);
  const byRoute = group((t) => `${t.origin} → ${t.dest}`).filter((r) => r.tasks >= 3).sort((a, b) => b.rate - a.rate);
  const timeouts = valid.filter((t) => t.timeout).length;
  return {
    tasks: tasks.length,
    valid: valid.length,
    invalid,
    onTime: valid.length ? 1 - timeouts / valid.length : 1,
    timeouts,
    avgWait: round(avg(valid.map((t) => t.waitS)), 0),
    byAgv,
    byRoute,
    window: tasks.length ? `${tasks[0].issuedAt} 至 ${tasks.at(-1)!.issuedAt}` : '',
  };
}

export const agvAgent: AgentDefinition = {
  id: 'logistics.agv',
  module: 'logistics',
  name: 'AGV 调度助手',
  description: '分析 AGV 任务的按时率、超时车辆与线路、等待热点和调度数据异常',
  instructions: `你负责 AGV 调度。按时率对照${cite('SLM-2025-001-2.6')}中「AGV 任务自动执行率 ≥95%」；拥堵与死锁处理按${cite('SLM-2025-001-5.2')}；起点与终点相同的任务是数据异常，不计入按时率。`,
  starters: ['哪台 AGV 超时最多？', 'AGV 按时率达标了吗', '哪条线路最堵'],
  context({ db }) {
    const a = agvSummary(db);
    if (a.tasks === 0) return { headline: '暂无 AGV 任务数据', blocks: [] };
    const worst = a.byAgv[0];
    return {
      headline: `AGV 按时率 ${percent(a.onTime, 1)}${a.onTime < AGV_TARGET ? '，低于 95% 目标' : '，达到 95% 目标'}；${worst.key} 超时率 ${percent(worst.rate, 1)} 最高`,
      blocks: [
        { title: '按车辆', lines: a.byAgv.map((g) => `${g.key}：${g.tasks} 单，超时 ${g.timeouts}（${percent(g.rate, 1)}），平均等待 ${g.wait} 秒`) },
        { title: '超时率最高的线路（≥3 单）', lines: a.byRoute.slice(0, 5).map((g) => `${g.key}：${g.tasks} 单，超时 ${percent(g.rate, 1)}，平均等待 ${g.wait} 秒`) },
        { title: '调度数据异常', lines: [`${a.invalid.length} 单起点与终点相同（如 ${a.invalid.slice(0, 3).map((t) => `${t.id} ${t.origin}`).join('、')}），已从按时率中剔除`] },
        { title: '依据', lines: [`${cite('SLM-2025-001-2.6')}：AGV 任务自动执行率 ≥95%`, `${cite('SLM-2025-001-5.2')}：死锁与拥堵触发后调度工程师 10 分钟内介入，反复出现的路段纳入地图优化`, `${cite('SLM-2025-001-4.3')}：电池健康档案，容量衰减超限立即停用更换`] },
      ],
      facts: [`${a.window} 共 ${a.tasks} 单，有效 ${a.valid} 单，按时率 ${percent(a.onTime, 1)}`, `${worst.key} 超时 ${worst.timeouts}/${worst.tasks} 单`, `${a.invalid.length} 单起点与终点相同，属数据异常`],
      pending: ['起终点相同的任务需核对 RCS 地图与任务下发记录'],
      suggestions: [`检查 ${worst.key} 的电池健康与导航，必要时下线保养`, `对超时最高的线路「${a.byRoute[0]?.key ?? '—'}」做路径与让行规则优化`],
      artifacts: [
        { kind: 'table', title: 'AGV 车辆表现', columns: ['车辆', '有效任务', '超时', '超时率', '平均等待(秒)'], rows: a.byAgv.map((g) => [g.key, g.tasks, g.timeouts, percent(g.rate, 1), g.wait]) },
        { kind: 'table', title: '线路超时', columns: ['线路', '任务', '超时率', '平均等待(秒)'], rows: a.byRoute.map((g) => [g.key, g.tasks, percent(g.rate, 1), g.wait]) },
      ],
    };
  },
};

export function syncAgvAlerts(deps: Deps): void {
  if (!hasAgv(deps.db)) return;
  const a = agvSummary(deps.db);
  const worst = a.byAgv[0];
  syncStateAlerts(deps, 'logistics', 'agv_timeout', a.onTime < AGV_TARGET
    ? [{
        key: 'fleet',
        title: `AGV 按时率 ${percent(a.onTime, 1)}，低于 95%`,
        summary: `${a.valid} 单有效任务超时 ${a.timeouts} 单；${worst.key} 超时率 ${percent(worst.rate, 1)}，平均等待 ${worst.wait} 秒；另有 ${a.invalid.length} 单起终点相同的调度数据异常`,
        // Late deliveries to line-side stores show up on the lines as 缺料待料.
        payload: { onTime: a.onTime, worstAgv: worst.key, invalid: a.invalid.length, causes: ['缺料待料'] },
      }]
    : [], 'AGV 规则');
}
