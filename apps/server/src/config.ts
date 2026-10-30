import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Sent as reasoning_effort when set; 'low' keeps reasoning models (e.g. MiniMax-M3) fast enough for a live demo. */
  reasoningEffort: string | null;
}

/** 'official': the track's material pack (default). 'demo': the original fictional data, kept as test fixtures. */
export type Dataset = 'official' | 'demo';

export interface Config {
  dataset: Dataset;
  port: number;
  dbPath: string;
  llm: LlmConfig | null;
  bridgeToken: string | null;
  demoPassword: string;
  sessionHours: number;
  webDist: string | null;
}

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.LLM_API_KEY?.trim();
  return {
    dataset: env.DATASET === 'demo' ? 'demo' : 'official',
    port: Number(env.API_PORT ?? 8787),
    dbPath: env.DB_PATH ?? fileURLToPath(new URL('../data/agentos.db', import.meta.url)),
    llm: apiKey
      ? {
          baseUrl: (env.LLM_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
          apiKey,
          model: env.LLM_MODEL ?? 'qwen-plus',
          reasoningEffort: env.LLM_REASONING_EFFORT?.trim() || null,
        }
      : null,
    bridgeToken: env.BRIDGE_TOKEN?.trim() || null,
    demoPassword: env.DEMO_PASSWORD?.trim() || 'agentos-demo',
    sessionHours: Number(env.SESSION_HOURS ?? 12),
    webDist: existsSync(DEFAULT_WEB_DIST) ? DEFAULT_WEB_DIST : null,
  };
}
