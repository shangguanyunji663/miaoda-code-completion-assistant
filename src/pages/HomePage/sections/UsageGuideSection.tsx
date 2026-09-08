import { memo, useState } from 'react';
import { ChevronDown, ChevronUp, Lightbulb, Copy, Play, RefreshCcw, CheckCircle2, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const STEPS = [
  {
    icon: FileCode,
    title: '第一步：复制题目与模板',
    desc: '打开编程评测平台（如头歌/Educoder）的题目页面，将左侧的任务描述、编程要求、测试说明等文字复制到本工具的「题目描述」输入框；再将右侧代码编辑器中的完整代码模板（含 Begin/End 标记）复制到「代码模板」输入框。',
  },
  {
    icon: Play,
    title: '第二步：AI 生成代码',
    desc: '选择正确的编程语言，点击「AI 生成补全代码」按钮。AI 将扮演资深算法工程师，根据题目要求在 Begin/End 标记之间自动补全代码实现，输出完整可直接提交的代码。',
  },
  {
    icon: Copy,
    title: '第三步：复制到平台并评测',
    desc: '点击代码输出区右上角的「复制」按钮，将生成的完整代码粘贴回评测平台的代码编辑器中，点击平台的「评测」或「提交」按钮运行测试。',
  },
  {
    icon: RefreshCcw,
    title: '第四步：粘贴评测结果并反思重试',
    desc: '将平台返回的评测结果（包含错误信息、预期输出对比等）完整复制到本工具的「评测结果」输入框，点击「AI 反思并重试」按钮。AI 会先分析失败原因，再生成修正后的代码。重复此过程直到全部通过。',
  },
  {
    icon: CheckCircle2,
    title: '第五步：识别成功信号',
    desc: '当评测结果中出现「全部通过」「答案正确」「Accepted」等关键词时，工具会自动识别并提示评测通过，迭代结束。',
  },
];

function UsageGuideSection() {
  const [open, setOpen] = useState(false);

  return (
    <section className="w-full bg-muted/30 py-10 md:py-12 border-t border-border/40">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Lightbulb className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">使用说明</h2>
              <p className="text-sm text-muted-foreground">与在线评测平台配合使用的完整工作流</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            className="gap-1"
          >
            {open ? (
              <>
                收起 <ChevronUp className="w-4 h-4" />
              </>
            ) : (
              <>
                展开查看 <ChevronDown className="w-4 h-4" />
              </>
            )}
          </Button>
        </div>

        {open && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              return (
                <Card key={index} className="border-border/60 bg-card">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Icon className="w-4.5 h-4.5 text-primary" />
                      </div>
                      <CardTitle className="text-sm font-semibold">{step.title}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default memo(UsageGuideSection);
