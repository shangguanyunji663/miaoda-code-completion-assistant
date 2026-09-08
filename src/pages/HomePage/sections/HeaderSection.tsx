import { memo } from 'react';
import { Bot, Code2, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

function HeaderSection() {
  return (
    <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-md border-b border-border/30">
      <div className="max-w-7xl mx-auto px-4 md:px-6 flex h-16 items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary text-primary-foreground shrink-0">
            <Code2 className="w-5 h-5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm md:text-base font-semibold text-foreground">
              编程题自动补全与评测迭代助手
            </span>
            <span className="text-xs text-muted-foreground hidden sm:block">
              AI 驱动 · 自动生成代码 · 智能反思重试
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 text-xs font-normal hidden sm:inline-flex">
            <Sparkles className="w-3 h-3 text-primary" />
            AI Powered
          </Badge>
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50">
            <Bot className="w-4 h-4 text-primary" />
            <span className="text-xs font-medium text-foreground hidden sm:inline">
              智能助手
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default memo(HeaderSection);
