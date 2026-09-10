# capabilities

本目录存放 AI 能力配置，是 **agent 的 prompt 单一数据源**——`agent/src/ai.mjs` 直接读取本目录文件并渲染 `{{input.xxx}}` 占位符，不在 agent 内复制 prompt。

| 文件 | 用途 |
|---|---|
| `task_router_1.json` | 题干意图路由器：按任务描述判定该题是代码题（code）、命令行题（cmdline）还是混合题（mixed，先命令行数据准备再写代码栏） |
| `code_completion_generator_1.json` | 代码补全生成器：根据题目 + 模板在 Begin/End 之间补全代码 |
| `code_reflection_fixer_1.json` | 代码反思修复器：根据评测结果分析失败原因并生成修正代码 |
| `cmdline_runner_1.json` | 命令行任务执行器：根据运维/数据库类任务描述生成逐行执行的命令序列 |
| `cmdline_reflection_fixer_1.json` | 命令行反思修复器：评测未通过时分析原因并重新给出完整命令序列 |
| `quiz_answer_selector_1.json` | 选择题/填空题单题作答器：只输出答案本身 |
| `quiz_batch_answer_1.json` | 整页多小题批量作答器：输出「题号:字母」，多选连写 |

> 数据库命令题守则（0.9.2）：`code_completion_generator_1` 实现要求第 7 条与
> `code_reflection_fixer_1` 解读守则第 4 条约定——平台把代码栏内容当 shell 脚本执行时，
> 命令中的 `$` 一律按题面转义（`\$`），报错 `query.sh: syntax error near unexpected token`
> 归因为 `$` 未转义/命令形态非脚本可执行。

## 修改约定

- 改 AI 行为**只改本目录的 JSON**，不改 `agent/src/*.mjs`。
- prompt 中的 `{{input.xxx}}` 由 `agent/src/ai.mjs` 的 `renderPrompt` 渲染，新增占位符需同步传入对应字段。
- 历史上本目录同时服务一个手动工作台前端，该前端已于 2026-09-09 移除，当前消费方仅 agent。
