// Streamed turns: answer text arrives as the model writes it, then the saved turn.
import { describe, expect, it } from 'vitest';
import { createApp, createDeps } from '../src/app.ts';
import type { ChatMessage, LlmProvider } from '../src/core/agents/providers.ts';
import { partialAnswer } from '../src/core/agents/prompt.ts';
import { openDb } from '../src/db.ts';
import { seedAll } from '../src/seed/index.ts';
import { BRIDGE_TOKEN, PASSWORD } from './helpers.ts';

const OUTPUT = '<think>先看数据</think>{"title":"线束03","answer":"线束03 约 3 天后断料。\\n建议走\\"紧急采购\\"。","facts":[],"pending":[],"suggestions":[],"actions":[]}';

class ChunkedProvider implements LlmProvider {
  readonly mode = 'llm';
  readonly model = 'fake-stream';
  async complete(): Promise<string> {
    return OUTPUT;
  }
  async stream(_messages: ChatMessage[], onText: (chunk: string) => void): Promise<string> {
    for (let i = 0; i < OUTPUT.length; i += 7) onText(OUTPUT.slice(i, i + 7));
    return OUTPUT;
  }
}

describe('streamed turns', () => {
  it('decodes the answer field of partial JSON', () => {
    expect(partialAnswer('{"answer":"第一行\\n第二')).toBe('第一行\n第二');
    expect(partialAnswer('<think>{"answer":"x"}')).toBe('');
    expect(partialAnswer('{"title":"a","answer":"引\\"号\\u4e2d')).toBe('引"号中');
  });

  it('sends answer deltas and then the saved turn', async () => {
    const config = { dataset: 'official' as const, port: 0, dbPath: ':memory:', llm: null, bridgeToken: BRIDGE_TOKEN, demoPassword: PASSWORD, sessionHours: 12, webDist: null };
    const deps = createDeps(config, { db: openDb(':memory:'), clock: () => new Date('2026-10-30T09:00:00+08:00'), provider: new ChunkedProvider() });
    seedAll(deps);
    const app = createApp(deps);
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chairman', password: PASSWORD }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/api/agents/supply.inventory/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Cookie: cookie },
      body: JSON.stringify({ question: '线束03 安全库存够不够？' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = (await res.text()).split('\n\n').filter(Boolean).map((block) => ({
      event: block.match(/^event: (.+)$/m)?.[1],
      data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? 'null'),
    }));
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.map((e) => e.data.text).join('')).toBe('线束03 约 3 天后断料。\n建议走"紧急采购"。');
    const final = events.at(-1)!;
    expect(final.event).toBe('turn');
    expect(final.data.turn.result.answer).toContain('紧急采购');
    expect(final.data.turn.mode).toBe('llm');
  });
});
