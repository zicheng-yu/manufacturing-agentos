import { listEvents } from '../../core/events.ts';
import type { AgentDefinition } from '../../core/module.ts';
import { percent, round } from '../../core/util.ts';
import { disposalFor, stationStats, totals } from './data.ts';

export const siteAgent: AgentDefinition = {
  id: 'logistics.site',
  module: 'logistics',
  name: '现场异常助手',
  description: '汇总识别、抓取、码垛工位状态，对异常给出处置建议',
  instructions: '你负责厂内物流现场。先指出异常工位和影响，再按事件类型给处置建议（重试、人工介入或改道），不要编造设备参数。',
  starters: ['现在哪个工位有问题？', '码垛-02 抓取失败怎么处理', '近一小时的抓取成功率'],
  context({ db, deps }) {
    const stats = stationStats(db);
    const t = totals(stationStats(db, 1));
    const open = listEvents(deps, { domains: ['logistics'], status: 'unresolved', limit: 20 });
    return {
      headline: open.length ? `${open.length} 条现场异常待处理` : '现场运行正常',
      blocks: [
        {
          title: '全站最新读数',
          lines: [
            `抓取成功率 ${percent(t.picks - t.pickFailures, t.picks)}（${t.picks} 次中失败 ${t.pickFailures} 次），码垛合规率 ${percent(t.placements - t.placementInvalid, t.placements)}，入库积压 ${t.backlog} 箱`,
          ],
        },
        {
          title: '各工位最近 6 次上报',
          lines: stats.map((s) =>
            s.picks || s.recognitions
              ? `${s.station}：识别 ${s.recognitions}（失败 ${s.recognitionFailures}），抓取 ${s.picks}（成功率 ${percent(s.picks - s.pickFailures, s.picks)}），不合规码放 ${s.placementInvalid}，节拍 ${s.avgCycleTime === null ? '—' : round(s.avgCycleTime, 1)} 秒`
              : `${s.station}：积压 ${s.backlog} 箱`,
          ),
        },
        {
          title: '未处理异常与处置建议',
          lines: open.length ? open.map((e) => `${e.title}（${e.count} 次）：${e.summary}。建议：${disposalFor(e.type)}`) : ['无'],
        },
      ],
      facts: open.map((e) => `${e.title}，累计 ${e.count} 次`),
      suggestions: [...new Set(open.map((e) => `${e.source.station ?? '现场'}：${disposalFor(e.type)}`))],
      artifacts: [
        {
          kind: 'table',
          title: '工位指标（各工位最近 6 次上报）',
          columns: ['工位', '识别', '识别失败', '抓取', '抓取失败', '抓取成功率', '码放', '不合规', '平均节拍(秒)', '积压'],
          rows: stats.map((s) => [
            s.station,
            s.recognitions,
            s.recognitionFailures,
            s.picks,
            s.pickFailures,
            percent(s.picks - s.pickFailures, s.picks),
            s.placements,
            s.placementInvalid,
            s.avgCycleTime === null ? '—' : round(s.avgCycleTime, 1),
            s.backlog,
          ]),
        },
      ],
    };
  },
};
