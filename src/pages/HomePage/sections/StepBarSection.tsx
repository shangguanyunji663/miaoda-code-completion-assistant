import { memo } from 'react';
import { Check, Code2, Copy, FileText, RefreshCw, PlayCircle } from 'lucide-react';

interface StepBarProps {
  currentStep: number;
  passed: boolean;
}

const STEPS = [
  { id: 1, title: '粘贴题目与模板', icon: FileText, desc: '复制题目描述和代码模板' },
  { id: 2, title: 'AI 生成补全代码', icon: Code2, desc: 'AI 自动生成第 1 版代码' },
  { id: 3, title: '复制到平台评测', icon: Copy, desc: '粘贴到评测平台并提交' },
  { id: 4, title: '粘贴评测结果', icon: PlayCircle, desc: '把评测结果粘贴回来' },
  { id: 5, title: 'AI 反思重试', icon: RefreshCw, desc: 'AI 分析并生成修正代码' },
];

function StepBarSection({ currentStep, passed }: StepBarProps) {
  const displayStep = passed ? 5 : currentStep;

  return (
    <section className="w-full bg-gradient-to-br from-primary/5 via-background to-secondary/10 py-8 md:py-10 border-b border-border/40">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="flex items-center justify-between gap-2 md:gap-4">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            const isCompleted = passed || step.id < displayStep;
            const isCurrent = !passed && step.id === displayStep;
            const isPassedFinal = passed && step.id === 5;

            return (
              <div key={step.id} className="flex items-center flex-1 min-w-0">
                <div className="flex flex-col items-center flex-1 min-w-0">
                  <div
                    className={`relative flex items-center justify-center w-10 h-10 md:w-11 md:h-11 rounded-full shrink-0 transition-all duration-300 ${
                      isPassedFinal
                        ? 'bg-success text-success-foreground ring-4 ring-success/20'
                        : isCompleted
                          ? 'bg-primary text-primary-foreground'
                          : isCurrent
                            ? 'bg-primary text-primary-foreground ring-4 ring-primary/20 scale-110'
                            : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isCompleted && !isPassedFinal ? (
                      <Check className="w-5 h-5" />
                    ) : isPassedFinal ? (
                      <Check className="w-5 h-5" />
                    ) : (
                      <Icon className="w-5 h-5" />
                    )}
                  </div>
                  <div className="mt-2 text-center min-w-0">
                    <p
                      className={`text-xs md:text-sm font-medium truncate ${
                        isCurrent || isCompleted ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      第{step.id}步 · {step.title}
                    </p>
                  </div>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={`hidden md:block h-0.5 flex-1 mx-2 rounded-full transition-colors duration-500 ${
                      step.id < displayStep || passed ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
        {passed && (
          <div className="mt-6 text-center">
            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-success/10 text-success text-sm font-medium">
              <Check className="w-4 h-4" />
              恭喜！评测已全部通过，迭代完成
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

export default memo(StepBarSection);
