import type { LlmConfig } from '../../config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  mode: 'llm' | 'offline';
  model: string | null;
  /** Returns the raw model output. Only called when mode is 'llm'. */
  complete(messages: ChatMessage[]): Promise<string>;
}

/** Works with any OpenAI-compatible chat completions endpoint (DashScope/Qwen, DeepSeek, Moonshot…). */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly mode = 'llm';
  readonly model: string;
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = config;
    this.model = config.model;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        ...(this.config.reasoningEffort && { reasoning_effort: this.config.reasoningEffort }),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型接口未返回内容');
    return content;
  }
}

/** No model configured: agents answer from their deterministic analysis alone. */
export class OfflineProvider implements LlmProvider {
  readonly mode = 'offline';
  readonly model = null;

  async complete(): Promise<string> {
    throw new Error('离线模式不调用模型');
  }
}

export function createProvider(config: LlmConfig | null): LlmProvider {
  return config ? new OpenAICompatibleProvider(config) : new OfflineProvider();
}
