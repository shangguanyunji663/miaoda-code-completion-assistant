import generatorConfig from '@shared/capabilities/code_completion_generator_1.json';
import reflectionConfig from '@shared/capabilities/code_reflection_fixer_1.json';

/**
 * 本地 AI 客户端：通过 OpenAI 兼容的 /chat/completions 流式接口
 * 替代妙搭平台的 capabilityClient.load(...).callStream('textGenerate', ...)。
 *
 * 配置（项目根目录 .env.local，模板见 .env.example）：
 *   VITE_AI_BASE_URL  API 基础地址，结尾不带斜杠。
 *                     豆包方舟：https://ark.cn-beijing.volces.com/api/v3
 *                     OpenAI：https://api.openai.com/v1
 *                     DeepSeek：https://api.deepseek.com/v1
 *   VITE_AI_API_KEY   你的 API Key
 *   VITE_AI_MODEL     模型名，如 doubao-seed-1-6-250615 / gpt-4o-mini / deepseek-chat
 *
 * prompt 模板与 modelParams 仍来自 shared/capabilities/*.json（改 prompt 请改 JSON）。
 */

export interface AIStreamChunk {
  /** 与 capabilityClient 插件输出一致的增量文本字段 */
  content: string;
}

interface StreamOptions {
  /** 渲染后的完整提示词 */
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

// ---------- 配置读取 ----------

function readConfig() {
  return {
    baseURL: (import.meta.env.VITE_AI_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    apiKey: (import.meta.env.VITE_AI_API_KEY ?? '').trim(),
    model: (import.meta.env.VITE_AI_MODEL ?? '').trim(),
  };
}

/** 是否已配置完整的 AI 调用参数 */
export function isAIConfigured(): boolean {
  const { baseURL, apiKey, model } = readConfig();
  return Boolean(baseURL && apiKey && model);
}

/** 渲染 capabilities 模板中的 {{input.xxx}} 占位符 */
export function renderPrompt(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const value = input[key];
    return value == null ? '' : String(value);
  });
}

// ---------- OpenAI 兼容 SSE 流式调用 ----------

export async function* streamChatCompletion(
  options: StreamOptions,
): AsyncGenerator<AIStreamChunk> {
  const { baseURL, apiKey, model } = readConfig();
  if (!baseURL || !apiKey || !model) {
    throw new Error(
      'AI 未配置：请在项目根目录 .env.local 中设置 VITE_AI_BASE_URL / VITE_AI_API_KEY / VITE_AI_MODEL（参考 .env.example）',
    );
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: options.prompt }],
      stream: true,
      temperature: options.temperature ?? 0.5,
      max_tokens: options.maxTokens ?? 8192,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // 忽略响应体读取失败
    }
    throw new Error(
      `AI 请求失败 (HTTP ${response.status})${detail ? `：${detail.slice(0, 300)}` : ''}`,
    );
  }

  if (!response.body) {
    throw new Error('AI 响应没有流式内容');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按行解析 SSE：data: {...} / data: [DONE]
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield { content: delta };
          }
        } catch {
          // 忽略无法解析的 SSE 行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------- 两个能力的流式入口（与 capabilities/*.json 一一对应） ----------

/** 代码补全生成器：根据题目 + 模板在 Begin/End 之间补全代码 */
export function streamGenerateCode(
  input: {
    problem_description: string;
    code_template: string;
    additional_requirements?: string;
  },
  signal?: AbortSignal,
): AsyncGenerator<AIStreamChunk> {
  const prompt = renderPrompt(generatorConfig.formValue.prompt, input);
  return streamChatCompletion({
    prompt,
    temperature: generatorConfig.formValue.modelParams.temperature,
    maxTokens: generatorConfig.formValue.modelParams.maxTokens,
    signal,
  });
}

/** 代码反思修复器：结合题目 + 上一版代码 + 评测结果，先分析原因再生成修正代码 */
export function streamReflectCode(
  input: {
    problem_description: string;
    previous_code: string;
    evaluation_result: string;
  },
  signal?: AbortSignal,
): AsyncGenerator<AIStreamChunk> {
  const prompt = renderPrompt(reflectionConfig.formValue.prompt, input);
  return streamChatCompletion({
    prompt,
    temperature: reflectionConfig.formValue.modelParams.temperature,
    maxTokens: reflectionConfig.formValue.modelParams.maxTokens,
    signal,
  });
}
