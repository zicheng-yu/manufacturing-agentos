// Replays the demo storyline through the simulation bridge: `npm run replay` (add -- --fast to skip pauses).
// Needs a running server with BRIDGE_TOKEN set; reads the same .env.
import { storylineFor } from '../apps/server/src/seed/storyline.ts';

const base = process.env.AGENTOS_URL ?? `http://localhost:${process.env.API_PORT ?? 8787}`;
const token = process.env.BRIDGE_TOKEN;
const fast = process.argv.includes('--fast');
const STORYLINE = storylineFor(process.env.DATASET === 'demo' ? 'demo' : 'official');

if (!token) {
  console.error('未设置 BRIDGE_TOKEN：请先 cp .env.example .env');
  process.exit(1);
}

for (const [index, step] of STORYLINE.entries()) {
  await new Promise((resolve) => setTimeout(resolve, fast ? 300 : step.delayMs));
  const res = await fetch(`${base}${step.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
    body: JSON.stringify(step.body),
  });
  console.log(`[${index + 1}/${STORYLINE.length}] ${step.label} → ${res.status}`);
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }
}
console.log('回放完成。在驾驶舱点击「生成今日决策简报」。');
