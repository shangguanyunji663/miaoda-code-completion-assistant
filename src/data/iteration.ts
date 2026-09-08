// EXPORTS: ICodeVersion, IIterationState, LANGUAGE_OPTIONS, SUCCESS_KEYWORDS

/** 编程语言选项 */
export const LANGUAGE_OPTIONS = [
  { value: 'python', label: 'Python' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'java', label: 'Java' },
] as const;

export type Language = (typeof LANGUAGE_OPTIONS)[number]['value'];

/**
 * 代码版本历史条目
 */
export interface ICodeVersion {
  /** 版本号，从 1 开始递增 */
  version: number;
  /** 完整代码内容（含模板标记） */
  code: string;
  /** 编程语言 */
  language: Language;
  /** 该版本对应的评测结果（首次生成为空） */
  reviewResult?: string;
  /** AI 分析的失败原因与修复说明（首次生成为空） */
  fixAnalysis?: string;
  /** 生成时间戳 */
  timestamp: number;
  /** 来源：AI 生成 / 手动修改 */
  source: 'ai' | 'manual';
}

/**
 * 当前迭代状态
 */
export interface IIterationState {
  /** 当前步骤：1-粘贴题目 2-生成代码 3-复制评测 4-粘贴结果 5-反思重试 */
  currentStep: number;
  /** 当前查看的版本号 */
  currentVersion: number;
  /** 是否已全部通过 */
  passed: boolean;
  /** 题目描述缓存 */
  problemDescription?: string;
  /** 代码模板缓存 */
  codeTemplate?: string;
  /** 编程语言缓存 */
  language?: Language;
}

/** 成功信号关键词列表 */
export const SUCCESS_KEYWORDS = [
  '全部通过',
  '答案正确',
  '0 组不匹配',
  '0组不匹配',
  'Accepted',
  '通过',
  'PASS',
  'Pass',
  '恭喜你通过了',
  '恭喜通过',
  '评测通过',
  '测试通过',
  'All Passed',
  'AC',
] as const;
