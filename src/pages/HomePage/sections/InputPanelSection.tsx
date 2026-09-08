import { memo, useState, type ChangeEvent } from 'react';
import { Sparkles, FileCode, BookOpen, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LANGUAGE_OPTIONS, type Language } from '@/data/iteration';

interface InputPanelProps {
  problemDescription: string;
  codeTemplate: string;
  language: Language;
  evaluationResult: string;
  isGenerating: boolean;
  isReflecting: boolean;
  hasGenerated: boolean;
  onChangeProblem: (v: string) => void;
  onChangeCodeTemplate: (v: string) => void;
  onChangeLanguage: (v: Language) => void;
  onChangeEvaluationResult: (v: string) => void;
  onGenerate: () => void;
  onReflect: () => void;
}

function InputPanelSection({
  problemDescription,
  codeTemplate,
  language,
  evaluationResult,
  isGenerating,
  isReflecting,
  hasGenerated,
  onChangeProblem,
  onChangeCodeTemplate,
  onChangeLanguage,
  onChangeEvaluationResult,
  onGenerate,
  onReflect,
}: InputPanelProps) {
  const [problemOpen, setProblemOpen] = useState(true);
  const [codeOpen, setCodeOpen] = useState(true);
  const [resultOpen, setResultOpen] = useState(true);

  const canGenerate =
    problemDescription.trim().length > 0 && codeTemplate.trim().length > 0 && !isGenerating;
  const canReflect =
    evaluationResult.trim().length > 0 && hasGenerated && !isReflecting && !isGenerating;

  return (
    <div className="space-y-4">
      {/* 题目描述 */}
      <Card>
        <CardHeader
          className="cursor-pointer py-3 px-4"
          onClick={() => setProblemOpen((v) => !v)}
        >
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" />
            题目描述
            <span className="ml-auto text-xs text-muted-foreground font-normal">
              {problemOpen ? '点击收起' : '点击展开'}
            </span>
          </CardTitle>
        </CardHeader>
        {problemOpen && (
          <CardContent className="pt-0 space-y-3">
            <Textarea
              placeholder="粘贴题目的任务描述、编程要求、测试说明等全部内容..."
              className="min-h-[160px] font-mono text-sm resize-y"
              value={problemDescription}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                onChangeProblem(e.target.value)
              }
            />
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="language" className="text-xs text-muted-foreground whitespace-nowrap">
                  编程语言
                </Label>
                <Select value={language} onValueChange={(v) => onChangeLanguage(v as Language)}>
                  <SelectTrigger id="language" className="w-32 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 代码模板 */}
      <Card>
        <CardHeader
          className="cursor-pointer py-3 px-4"
          onClick={() => setCodeOpen((v) => !v)}
        >
          <CardTitle className="text-base flex items-center gap-2">
            <FileCode className="w-4 h-4 text-primary" />
            代码模板
            <span className="ml-auto text-xs text-muted-foreground font-normal">
              {codeOpen ? '点击收起' : '点击展开'}
            </span>
          </CardTitle>
        </CardHeader>
        {codeOpen && (
          <CardContent className="pt-0">
            <Textarea
              placeholder="粘贴含 Begin/End 标记的代码模板..."
              className="min-h-[180px] font-mono text-sm resize-y leading-relaxed"
              value={codeTemplate}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                onChangeCodeTemplate(e.target.value)
              }
            />
            <p className="mt-2 text-xs text-muted-foreground">
              提示：代码中需包含 Begin / End 标记，AI 只会在标记之间补全实现
            </p>
          </CardContent>
        )}
      </Card>

      {/* 生成按钮 */}
      <Button
        onClick={onGenerate}
        disabled={!canGenerate}
        className="w-full h-11 text-base gap-2"
      >
        <Sparkles className="w-4 h-4" />
        {isGenerating ? 'AI 正在生成代码...' : 'AI 生成补全代码'}
      </Button>

      {/* 评测结果 */}
      <Card className="mt-6">
        <CardHeader
          className="cursor-pointer py-3 px-4"
          onClick={() => setResultOpen((v) => !v)}
        >
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal className="w-4 h-4 text-warning" />
            评测结果
            <span className="ml-auto text-xs text-muted-foreground font-normal">
              {resultOpen ? '点击收起' : '点击展开'}
            </span>
          </CardTitle>
        </CardHeader>
        {resultOpen && (
          <CardContent className="pt-0">
            <Textarea
              placeholder="粘贴评测平台返回的评测结果（通过/失败、错误信息、预期输出等）..."
              className="min-h-[120px] font-mono text-sm resize-y"
              value={evaluationResult}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                onChangeEvaluationResult(e.target.value)
              }
            />
            <p className="mt-2 text-xs text-muted-foreground">
              将平台显示的测试结果完整粘贴到此处，AI 会分析失败原因并修正代码
            </p>
          </CardContent>
        )}
      </Card>

      {/* 反思重试按钮 */}
      <Button
        onClick={onReflect}
        disabled={!canReflect}
        variant="secondary"
        className="w-full h-11 text-base gap-2"
      >
        <Sparkles className="w-4 h-4" />
        {isReflecting ? 'AI 正在分析并修复...' : 'AI 反思并重试'}
      </Button>
      {!hasGenerated && (
        <p className="text-xs text-center text-muted-foreground">
          请先生成至少一版代码后再进行反思重试
        </p>
      )}
    </div>
  );
}

export default memo(InputPanelSection);
