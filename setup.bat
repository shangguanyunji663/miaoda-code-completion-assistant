@echo off
chcp 65001 >nul
echo ============================================
echo  编程题自动补全与评测迭代助手 - 本地启动
echo ============================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ 后重试。
  pause
  exit /b 1
)

echo [1/3] 安装依赖...
call npm install
if errorlevel 1 (
  echo [错误] npm install 失败，请检查网络后重试。
  pause
  exit /b 1
)

echo [2/3] 补齐 shadcn 组件...
call npx shadcn@latest add button card select textarea label badge sonner --yes

echo [3/3] 启动开发服务器 (http://localhost:8001)...
call npm run dev

pause
