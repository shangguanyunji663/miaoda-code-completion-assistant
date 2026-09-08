import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 检测评测结果是否包含通过关键词
 */
export function detectSuccess(result: string, keywords: readonly string[]): boolean {
  if (!result || !result.trim()) return false;
  return keywords.some((kw) => result.includes(kw));
}

/**
 * 从 AI 反思输出中提取代码块（```language ... ```）
 */
export function extractCodeFromMarkdown(markdown: string): string {
  const codeBlockRegex = /```[a-zA-Z]*\n([\s\S]*?)```/;
  const match = markdown.match(codeBlockRegex);
  if (match && match[1]) {
    return match[1].trim();
  }
  // 没有代码块就返回原始内容（可能 AI 直接输出了代码）
  return markdown.trim();
}

/**
 * 从 AI 反思输出中分离分析文本与代码
 * 返回 { analysis, code }
 */
export function splitAnalysisAndCode(markdown: string): { analysis: string; code: string } {
  const codeBlockRegex = /```[a-zA-Z]*\n([\s\S]*?)```/;
  const match = markdown.match(codeBlockRegex);

  if (match && match[1]) {
    const code = match[1].trim();
    // 分析部分 = 代码块之前的文本
    const analysis = markdown.slice(0, match.index ?? 0).trim();
    return { analysis, code };
  }

  return { analysis: markdown.trim(), code: '' };
}
