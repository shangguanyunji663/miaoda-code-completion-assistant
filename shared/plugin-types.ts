// ---- plugin:code_completion_generator_1 ----
// ============================================================
// 插件 code_completion_generator_1 (代码补全生成器) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface CodeCompletionGeneratorOneInput {
  /** 额外的代码实现要求（可选） */
  additional_requirements?: string;
  /** 算法题题目描述，包含输入输出要求、示例等 */
  problem_description: string;
  /** 代码模板，包含Begin和End标记，需要在标记之间补全代码 */
  code_template: string;
}

/**
 * capabilityClient.load('code_completion_generator_1').callStream<CodeCompletionGeneratorOneOutput>('textGenerate', input)
 * 每个 chunk 就是下面这个扁平对象，字段名与 CodeCompletionGeneratorOneOutput 一致，外面没有 data / choices / message 包装：
 *   {"response":"示例文本","content":"示例文本"}
 * 返回值可能是 AsyncIterable<chunk>，也可能是 { output: AsyncIterable<chunk> }，取流前先归一化。
 * 逐段累加：
 *   for await (const chunk of stream) { result += chunk.response ?? ''; }
 */
export interface CodeCompletionGeneratorOneOutput {
  /** [object Object] */
  response?: string;
  /** [object Object] */
  content: string;
}
// ---- end:code_completion_generator_1 ----

// ---- plugin:code_reflection_fixer_1 ----
// ============================================================
// 插件 code_reflection_fixer_1 (代码反思修复器) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface CodeReflectionFixerOneInput {
  /** 代码评测结果，包含错误信息、预期输出与实际输出对比等 */
  evaluation_result: string;
  /** 编程题目描述信息 */
  problem_description: string;
  /** 上一版提交的代码 */
  previous_code: string;
}

/**
 * capabilityClient.load('code_reflection_fixer_1').callStream<CodeReflectionFixerOneOutput>('textGenerate', input)
 * 每个 chunk 就是下面这个扁平对象，字段名与 CodeReflectionFixerOneOutput 一致，外面没有 data / choices / message 包装：
 *   {"content":"示例文本","response":"示例文本"}
 * 返回值可能是 AsyncIterable<chunk>，也可能是 { output: AsyncIterable<chunk> }，取流前先归一化。
 * 逐段累加：
 *   for await (const chunk of stream) { result += chunk.content ?? ''; }
 */
export interface CodeReflectionFixerOneOutput {
  /** [object Object] */
  content: string;
  /** [object Object] */
  response?: string;
}
// ---- end:code_reflection_fixer_1 ----
