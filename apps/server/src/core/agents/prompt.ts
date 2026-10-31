import type { ActionItem, Company, MemoryRecord } from '@agentos/shared';
import { z } from 'zod';
import type { AgentContext, AgentDefinition } from '../module.ts';
import type { ChatMessage } from './providers.ts';

export interface DraftResult {
  title: string;
  answer: string;
  facts: string[];
  pending: string[];
  suggestions: string[];
  actions: ActionItem[];
}

const text = z.string().transform((s) => s.trim());
const list = z.array(z.string()).catch([]).default([]);

const ModelOutput = z.object({
  title: text.catch('').default(''),
  answer: text,
  facts: list,
  pending: list,
  suggestions: list,
  actions: z
    .array(
      z.object({
        title: text,
        owner: z.string().nullish(),
        due: z.string().nullish(),
      }),
    )
    .catch([])
    .default([]),
});

const OUTPUT_SPEC = `只输出一个 JSON 对象，不要输出其他内容，字段如下：
{
  "title": "不超过 20 字的标题",
  "answer": "直接回答问题的正文，Markdown，先给一句结论再给依据，不超过 300 字",
  "facts": ["留空；事实仅由业务分析核验后写入，新增线索请放pending"],
  "pending": ["「已识别的待核项」之外需要责任人核实的信息，最多 3 条"],
  "suggestions": ["建议，写清谁做什么，最多 3 条"],
  "actions": []
}
已列出的事实、待核项和行动项系统会原样展示，不要改写后重复；新增行动建议放suggestions，不会自动建待办。没有可补充的就给空数组。
系统生成的表格会在右侧单独展示，正文引用关键数字即可，不要重画整张表。`;

export function renderBlocks(context: AgentContext): string {
  return context.blocks
    .map((block) => [`【${block.title}】`, ...block.lines.map((line) => `- ${line}`)].join('\n'))
    .join('\n\n');
}

export function buildMessages(input: {
  company: Company;
  agent: AgentDefinition;
  context: AgentContext;
  memory: MemoryRecord[];
  history: { input: string; answer: string }[];
  question: string;
  today: string;
}): ChatMessage[] {
  const system = [
    `你是${input.company.name}企业智能体系统中的「${input.agent.name}」。今天是 ${input.today}。`,
    input.agent.instructions,
    '规则：只依据下面提供的业务数据、本对话已确认的信息和对话历史作答，不要编造数字、日期、供应商、人名或原因；数据里没有的信息写进 pending，并在正文里直说「数据中没有」。',
    '业务数据里写着「待…」或为空的内容（例如「D4：待失效分析」），正文照实写，不得自行补全；业务数据里已经给出的数字直接引用，不要说「缺少」。',
    '问到数据里没有的物料、供应商或制度时，明确说「未收录」，不要拿别的条目顶替。',
    '事实、待核信息、建议要分开。',
    '本轮业务数据优先于历史回答。历史事实可能过期，历史待核和建议仍未确认；不要把上一轮助手的说法当成用户批准或执行结果。',
    OUTPUT_SPEC,
  ].join('\n\n');

  const memory = input.memory.length
    ? input.memory.map((m) => `- [${m.kind === 'fact' ? '历史事实' : m.kind === 'pending' ? '待核' : '建议'}；${m.createdAt}；来源${m.turnId ?? m.source}] ${m.content}`).join('\n')
    : '（暂无）';
  // Memory here is this conversation's working memory only.
  const deterministic = [
    input.context.facts?.length ? `已算出的事实：\n${input.context.facts.map((f) => `- ${f}`).join('\n')}` : '',
    input.context.pending?.length ? `已识别的待核项：\n${input.context.pending.map((f) => `- ${f}`).join('\n')}` : '',
    input.context.actions?.length
      ? `已列出的行动项：\n${input.context.actions.map((a) => `- ${a.title}（${a.owner ?? ''}，${a.due ?? ''}）`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  for (const turn of input.history) {
    messages.push({ role: 'user', content: turn.input }, { role: 'assistant', content: turn.answer });
  }
  messages.push({
    role: 'user',
    content: `${renderBlocks(input.context)}\n\n${deterministic}\n\n【本对话历史记录（含未确认事项，不代表当前状态）】\n${memory}\n\n【问题】\n${input.question}`,
  });
  return messages;
}

/** Drop reasoning blocks some models (e.g. MiniMax-M3) put in the content, and any text around the JSON object. */
export function extractJson(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** Parses model output; falls back to treating the whole text as the answer. */
export function parseModelOutput(raw: string): DraftResult {
  const cleaned = extractJson(raw);
  try {
    const parsed = ModelOutput.parse(JSON.parse(cleaned));
    return {
      ...parsed,
      actions: parsed.actions.map((a) => ({ title: a.title, owner: a.owner ?? undefined, due: a.due ?? undefined })),
    };
  } catch {
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return { title: '', answer, facts: [], pending: ['模型输出格式异常，以下正文未经结构化校验'], suggestions: [], actions: [] };
  }
}

/** The answer when no model is available: the agent's own analysis, rendered. */
export function offlineDraft(agent: AgentDefinition, context: AgentContext): DraftResult {
  const body = context.blocks
    .map((block) => [`**${block.title}**`, '', ...block.lines.map((line) => `- ${line}`)].join('\n'))
    .join('\n\n');
  return {
    title: context.headline ? context.headline.slice(0, 30) : agent.name,
    answer: [context.headline, body].filter(Boolean).join('\n\n'),
    facts: [],
    pending: [],
    suggestions: [],
    actions: [],
  };
}
