# capabilities

本目录存放 AI 能力插件配置（妙搭平台 capability 格式），是**主项目与 agent 子系统共享的 prompt 单一数据源**——`agent/src/ai.mjs` 直接读取本目录文件渲染 `{{input.xxx}}` 占位符，不在 agent 内复制 prompt。

| 文件 | 用途 | 消费方 |
|---|---|---|
| `code_completion_generator_1.json` | 代码补全生成器：根据题目+模板在 Begin/End 之间补全代码 | 主项目 + agent |
| `code_reflection_fixer_1.json` | 代码反思修复器：根据评测结果分析失败原因并生成修正代码 | 主项目 + agent |
| `quiz_answer_selector_1.json` | 选择题/填空题单题作答器：只输出答案本身 | agent |
| `quiz_batch_answer_1.json` | 整页多小题批量作答器：输出「题号:字母」，多选连写 | agent |

类型定义见 `../plugin-types.ts`。构建时该目录会被复制到 `dist/output_capabilities/`。
