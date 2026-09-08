import { useCallback, useEffect, useMemo, useState } from 'react';
import { logger, scopedStorage } from '@lark-apaas/client-toolkit-lite';
import { toast } from 'sonner';
import { streamGenerateCode, streamReflectCode } from '@/lib/aiClient';
import { detectSuccess, splitAnalysisAndCode } from '@/lib/utils';
import {
  ICodeVersion,
  SUCCESS_KEYWORDS,
  type Language,
} from '@/data/iteration';
import HeaderSection from './sections/HeaderSection';
import StepBarSection from './sections/StepBarSection';
import InputPanelSection from './sections/InputPanelSection';
import CodeOutputPanelSection from './sections/CodeOutputPanelSection';
import UsageGuideSection from './sections/UsageGuideSection';

const HISTORY_KEY = 'code_iteration_history';
const STATE_KEY = 'code_iteration_state';

const SAMPLE_PROBLEM = `第4关：公平信号量

任务描述：
本关任务：使用 Redis 实现公平信号量。

相关知识：
当各个客户端（应用服务器）的系统时间不一致时，计数信号量会出现分配紊乱问题。为了减少客户端的系统时间对获得信号量操作的影响，需要使用 Redis 统一产生的值进行信号量的排名。
为了完成本关任务，你需要掌握：1、redis相关命令，2、python相关命令。

编程要求：
编写 acquire_fair_semaphore(semname, limit=5, timeout=10) 函数实现获得公平信号量：
- 清除过期信号量：移除有序集合 semname 中分值小于当前时间减去 timeout 的成员，并通过交集操作同步清理 semname:owner
- 获取信号量：对计数器 incr 获取排序码，用排序码做分值将全局唯一标识符 uuid 加入 semname:owner，同时将该标识符以当前时间做分值加入 semname，若该标识符在 semname:owner 中的排名未超过 limit 则成功并返回标识符，否则从两个集合中移除并返回 None

编写 release_fair_semaphore(semname, identifier) 函数实现释放信号量：
- 从两个存储结构中移除该标识符，返回后一次移除的执行结果

测试说明：
预期输出如下：
Getting 3 semaphores with a limit of 3...
Got 3 semaphores
...
`;

const SAMPLE_TEMPLATE = `#!/usr/bin/env python
# -*- coding:utf-8 -*-

import uuid
import time
import redis

conn = redis.Redis()

# 获得公平信号量
def acquire_fair_semaphore(semname, limit=5, timeout=10):
    # 请在下面完成要求的功能
    #********* Begin *********#
    
    #********* End *********#

# 释放公平信号量
def release_fair_semaphore(semname, identifier):
    # 请在下面完成要求的功能
    #********* Begin *********#
    
    #********* End *********#
`;

export default function HomePage() {
  const [problemDescription, setProblemDescription] = useState('');
  const [codeTemplate, setCodeTemplate] = useState('');
  const [language, setLanguage] = useState<Language>('python');
  const [evaluationResult, setEvaluationResult] = useState('');
  const [versions, setVersions] = useState<ICodeVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [currentStep, setCurrentStep] = useState(1);
  const [passed, setPassed] = useState(false);

  // 流式生成状态
  const [isGenerating, setIsGenerating] = useState(false);
  const [isReflecting, setIsReflecting] = useState(false);
  const [streamingCode, setStreamingCode] = useState('');
  const [analysisText, setAnalysisText] = useState('');
  const [isAnalysisMode, setIsAnalysisMode] = useState(false);

  // 初始化：从 localStorage 读取
  useEffect(() => {
    try {
      const historyRaw = scopedStorage.getItem(HISTORY_KEY);
      const stateRaw = scopedStorage.getItem(STATE_KEY);

      if (historyRaw) {
        const history = JSON.parse(historyRaw) as ICodeVersion[];
        setVersions(history);
        if (history.length > 0) {
          setCurrentVersion(history[history.length - 1].version);
        }
      }
      if (stateRaw) {
        const state = JSON.parse(stateRaw);
        if (state.problemDescription) setProblemDescription(state.problemDescription);
        if (state.codeTemplate) setCodeTemplate(state.codeTemplate);
        if (state.language) setLanguage(state.language as Language);
        if (typeof state.currentStep === 'number') setCurrentStep(state.currentStep);
        if (typeof state.passed === 'boolean') setPassed(state.passed);
      } else {
        // 首次访问：填充示例
        setProblemDescription(SAMPLE_PROBLEM);
        setCodeTemplate(SAMPLE_TEMPLATE);
      }
    } catch (err) {
      logger.warn('Failed to load from storage:', String(err));
      setProblemDescription(SAMPLE_PROBLEM);
      setCodeTemplate(SAMPLE_TEMPLATE);
    }
  }, []);

  // 持久化
  useEffect(() => {
    try {
      scopedStorage.setItem(HISTORY_KEY, JSON.stringify(versions));
    } catch (err) {
      logger.warn('Failed to save history:', String(err));
    }
  }, [versions]);

  useEffect(() => {
    try {
      scopedStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          currentStep,
          currentVersion,
          passed,
          problemDescription,
          codeTemplate,
          language,
        }),
      );
    } catch (err) {
      logger.warn('Failed to save state:', String(err));
    }
  }, [currentStep, currentVersion, passed, problemDescription, codeTemplate, language]);

  const hasGenerated = useMemo(() => versions.length > 0, [versions.length]);

  // 成功信号检测
  useEffect(() => {
    if (!evaluationResult.trim()) return;
    const ok = detectSuccess(evaluationResult, SUCCESS_KEYWORDS);
    setPassed(ok);
    if (ok) {
      setCurrentStep(5);
      toast.success('🎉 恭喜！评测已通过，迭代完成');
    }
  }, [evaluationResult]);

  // 生成代码
  const handleGenerate = useCallback(async () => {
    if (!problemDescription.trim() || !codeTemplate.trim()) {
      toast.error('请填写题目描述和代码模板');
      return;
    }

    setIsGenerating(true);
    setIsAnalysisMode(false);
    setStreamingCode('');
    setAnalysisText('');
    setCurrentStep(2);

    try {
      const stream = streamGenerateCode({
        problem_description: problemDescription,
        code_template: codeTemplate,
        additional_requirements: `使用 ${language.toUpperCase()} 语言实现。严格保持模板中 Begin/End 标记以外的代码不变，只在标记之间补全实现。输出只包含完整代码，不要 markdown 代码块标记，也不要额外解释。`,
      });

      let fullCode = '';
      for await (const chunk of stream) {
        const piece = chunk.content ?? '';
        if (piece) {
          fullCode += piece;
          setStreamingCode(fullCode);
        }
      }

      // 清理可能的代码块标记
      let cleaned = fullCode.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
      }

      const newVersion: ICodeVersion = {
        version: versions.length + 1,
        code: cleaned,
        language,
        timestamp: Date.now(),
        source: 'ai',
      };

      setVersions((prev) => [...prev, newVersion]);
      setCurrentVersion(newVersion.version);
      setCurrentStep(3);
      toast.success(`代码生成完成，已生成第 ${newVersion.version} 版`);
    } catch (err) {
      logger.error('Generate failed:', String(err));
      toast.error('代码生成失败，请稍后重试');
    } finally {
      setIsGenerating(false);
      setStreamingCode('');
    }
  }, [problemDescription, codeTemplate, language, versions.length]);

  // 反思重试
  const handleReflect = useCallback(async () => {
    if (!evaluationResult.trim()) {
      toast.error('请粘贴评测结果');
      return;
    }
    if (versions.length === 0) {
      toast.error('请先生成至少一版代码');
      return;
    }

    const latest = versions[versions.length - 1];

    setIsReflecting(true);
    setIsAnalysisMode(true);
    setStreamingCode('');
    setAnalysisText('');
    setCurrentStep(5);

    try {
      const stream = streamReflectCode({
        problem_description: problemDescription,
        previous_code: latest.code,
        evaluation_result: evaluationResult,
      });

      let fullText = '';
      for await (const chunk of stream) {
        const piece = chunk.content ?? '';
        if (piece) {
          fullText += piece;
          setAnalysisText(fullText);
        }
      }

      // 从输出中分离分析与代码
      const { analysis, code } = splitAnalysisAndCode(fullText);

      if (!code.trim()) {
        toast.error('未能从 AI 输出中提取代码，请重试');
        return;
      }

      // 展示提取的代码
      setIsAnalysisMode(false);
      setStreamingCode(code);

      const newVersion: ICodeVersion = {
        version: versions.length + 1,
        code: code.trim(),
        language,
        reviewResult: evaluationResult,
        fixAnalysis: analysis,
        timestamp: Date.now(),
        source: 'ai',
      };

      setVersions((prev) => [...prev, newVersion]);
      setCurrentVersion(newVersion.version);
      toast.success(`已生成第 ${newVersion.version} 版修正代码`);
    } catch (err) {
      logger.error('Reflection failed:', String(err));
      toast.error('AI 反思服务暂不可用，请稍后重试');
    } finally {
      setIsReflecting(false);
      setStreamingCode('');
      setIsAnalysisMode(false);
    }
  }, [evaluationResult, versions, problemDescription, language]);

  // 当粘贴评测结果时推进步骤
  const handleEvaluationChange = useCallback(
    (v: string) => {
      setEvaluationResult(v);
      if (v.trim() && currentStep < 4) {
        setCurrentStep(4);
      }
    },
    [currentStep],
  );

  return (
    <div className="min-h-screen bg-background">
      <HeaderSection />
      <StepBarSection currentStep={currentStep} passed={passed} />

      <main className="max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* 左侧输入区 */}
          <div className="lg:col-span-2 order-2 lg:order-1">
            <InputPanelSection
              problemDescription={problemDescription}
              codeTemplate={codeTemplate}
              language={language}
              evaluationResult={evaluationResult}
              isGenerating={isGenerating}
              isReflecting={isReflecting}
              hasGenerated={hasGenerated}
              onChangeProblem={setProblemDescription}
              onChangeCodeTemplate={setCodeTemplate}
              onChangeLanguage={setLanguage}
              onChangeEvaluationResult={handleEvaluationChange}
              onGenerate={handleGenerate}
              onReflect={handleReflect}
            />
          </div>

          {/* 右侧输出区 */}
          <div className="lg:col-span-3 order-1 lg:order-2">
            <CodeOutputPanelSection
              versions={versions}
              currentVersion={currentVersion}
              isStreaming={isGenerating || isReflecting}
              streamingCode={streamingCode}
              analysisText={analysisText}
              isAnalysisMode={isAnalysisMode}
              onVersionChange={setCurrentVersion}
            />
          </div>
        </div>
      </main>

      <UsageGuideSection />
    </div>
  );
}
