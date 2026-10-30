// The official pack is what the demo runs on: its situations, the agents' figures and the storyline must hold.
import type { Signal } from '@agentos/shared';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_STORYLINE } from '../src/seed/storyline.ts';
import { setup } from './helpers.ts';

type Cockpit = { situations: { domain: string; level: string; headline: string }[]; signals: Signal[] };

const official = () => setup(new Date('2026-10-30T09:00:00+08:00'), 'official');

async function ask(env: ReturnType<typeof setup>, cookie: string, agentId: string, question: string) {
  const res = await env.send('POST', `/api/agents/${agentId}/turns`, { question }, { Cookie: cookie });
  expect(res.status, agentId).toBe(200);
  return res.body.turn.result;
}

describe('official dataset', () => {
  it('puts every module on the official figures', async () => {
    const env = official();
    const cookie = await env.login('chairman');
    const cockpit = await env.get<Cockpit>('/api/cockpit', cookie);
    const headline = Object.fromEntries(cockpit.body.situations.map((s) => [s.domain, s.headline]));
    expect(headline.supply).toContain('线束03');
    expect(headline.quality).toContain('致命不良未开 8D');
    expect(headline.logistics).toContain('AGV 按时率');
    expect(headline.ehs).toContain('高风险违规');
    const titles = cockpit.body.signals.map((s) => s.title);
    expect(titles).toContain('全厂 OEE 70%，低于目标 75%');
    expect(titles.some((t) => t.includes('AOI 漏检率'))).toBe(true);
  });

  it('answers with the regulations and the pack figures', async () => {
    const env = official();
    const cookie = await env.login('chairman');
    const sourcing = await ask(env, cookie, 'supply.sourcing', '线束快断货了，几家供应商怎么选？');
    expect(sourcing.answer).toContain('宁波华翔');
    expect(sourcing.answer).toContain('5.2');
    const agv = await ask(env, cookie, 'logistics.agv', '哪台 AGV 超时最多？');
    expect(agv.title).toContain('AGV-02');
    expect(agv.answer).toContain('28 单起点与终点相同');
    const leave = await ask(env, cookie, 'hr.service', '年假有几天？');
    expect(JSON.stringify(leave)).toContain('6.4');
  });

  it('replays 线束03 的连锁反应 into linked decisions', async () => {
    const env = official();
    for (const step of OFFICIAL_STORYLINE) {
      const res = await env.bridge(step.path, step.body);
      expect(res.status, step.label).toBe(200);
      env.advance(0.5);
    }
    const cookie = await env.login('chairman');
    const cockpit = await env.get<Cockpit>('/api/cockpit', cookie);
    const titles = cockpit.body.signals.map((s) => s.title);
    expect(titles).toContain('EQ-IM-012 振动超限 4.9 mm/s');
    expect(titles).toContain('AGV-02 配送连续超时');
    expect(titles).toContain('苏州精工科技线束交付能力下降');

    const briefing = await env.send('POST', '/api/cockpit/briefing', {}, { Cookie: cookie });
    const result = briefing.body.turn.result;
    expect(result.artifacts[0].rows).toHaveLength(3);
    const harness = result.facts.find((f: string) => f.startsWith('M-10003：'));
    expect(harness).toContain('智能物流「');
    expect(harness).toContain('供应链「');
    expect(result.facts.some((f: string) => f.startsWith('缺料待料：') && f.includes('生产设备「'))).toBe(true);
    expect(result.facts.some((f: string) => f.includes('供应链部减员预警与供应链风险叠加'))).toBe(true);
  });
});
