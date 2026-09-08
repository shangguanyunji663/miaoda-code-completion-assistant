import { memo, useState } from 'react';
import { Copy, Check, Code2, Clock, Sparkles, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { ICodeVersion } from '@/data/iteration';
import { cn } from '@/lib/utils';

interface CodeOutputPanelProps {
  versions: ICodeVersion[];
  currentVersion: number;
  isStreaming: boolean;
  streamingCode: string;
  analysisText: string;
  isAnalysisMode: boolean;
  onVersionChange: (v: number) => void;
}

function CodeOutputPanelSection({
  versions,
  currentVersion,
  isStreaming,
  streamingCode,
  analysisText,
  isAnalysisMode,
  onVersionChange,
}: CodeOutputPanelProps) {
  const [copied, setCopied] = useState(false);

  const current = versions.find((v) => v.version === currentVersion);
  const displayCode = isStreaming ? streamingCode : current?.code ?? '';
  const displayAnalysis = isStreaming
    ? isAnalysisMode
      ? analysisText
      : current?.fixAnalysis ?? ''
    : current?.fixAnalysis ?? '';

  const handleCopy = async () => {
    if (!displayCode) return;
    try {
      await navigator.clipboard.writeText(displayCode);
      setCopied(true);
      toast.success('代码已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const isEmpty = versions.length === 0 && !isStreaming;

  return (
    <div className="space-y-4 h-full flex flex-col">
      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader className="py-3 px-4 border-b border-border/40 shrink-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <Code2 className="w-4 h-4 text-primary" />
              代码输出
              {isStreaming && (
                <Badge variant="outline" className="gap-1 text-xs font-normal animate-pulse">
                  <Sparkles className="w-3 h-3" />
                  生成中
                </Badge>
              )}
              {!isStreaming && versions.length > 0 && current && (
                <Badge variant="secondary" className="text-xs font-normal">
                  第 {current.version} 版
                </Badge>
              )}
            </CardTitle>

            <div className="flex items-center gap-2">
              {versions.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-muted-foreground" />
                  <Select
                    value={String(currentVersion)}
                    onValueChange={(v) => onVersionChange(Number(v))}
                    disabled={isStreaming}
                  >
                    <SelectTrigger className="w-28 h-8 text-xs">
                      <SelectValue placeholder="选择版本" />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((v) => (
                        <SelectItem key={v.version} value={String(v.version)}>
                          第 {v.version} 版
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={handleCopy}
                disabled={!displayCode}
                className="h-8 gap-1.5"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-success" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    复制
                  </>
                )}
              </Button>
            </div>
          </div>
          {current && !isStreaming && (
            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              生成于 {format(current.timestamp, 'MM-dd HH:mm:ss')}
              <span className="text-border">·</span>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-normal">
                {current.language.toUpperCase()}
              </Badge>
            </div>
          )}
        </CardHeader>

        <CardContent className="p-0 flex-1 min-h-0 relative">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-6">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                <Code2 className="w-7 h-7 text-muted-foreground" />
              </div>
              <h3 className="text-base font-medium text-foreground mb-1">
                等待生成代码
              </h3>
              <p className="text-sm text-muted-foreground max-w-xs">
                在左侧输入题目描述和代码模板后，点击「AI 生成补全代码」按钮，AI 将自动在 Begin/End 标记之间补全实现
              </p>
            </div>
          ) : (
            <div className="h-full min-h-[300px] max-h-[560px] overflow-auto bg-muted/30">
              <pre className="p-4 text-sm font-mono leading-relaxed text-foreground">
                <code>{displayCode}</code>
                {isStreaming && (
                  <span className="inline-block w-2 h-4 bg-primary ml-0.5 animate-pulse align-middle" />
                )}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI 分析说明区（仅反思模式有内容时显示） */}
      {displayAnalysis && (
        <Card>
          <CardHeader className="py-3 px-4 border-b border-border/40">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              AI 失败原因分析
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <div
              className={cn(
                'text-sm text-foreground leading-relaxed whitespace-pre-wrap prose prose-sm max-w-none dark:prose-invert',
              )}
            >
              {displayAnalysis}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default memo(CodeOutputPanelSection);
