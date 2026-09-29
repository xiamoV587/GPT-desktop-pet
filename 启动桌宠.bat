@echo off
chcp 65001 >nul
cd /d "%~dp0"
where npm >nul 2>nul || (echo 没有检测到 Node.js，请先安装：https://nodejs.org/ & pause & exit /b)
if not exist node_modules (
  echo 首次运行，正在安装依赖（需要几分钟）...
  call npm install --registry=https://registry.npmmirror.com
)
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rem 直接启动 electron.exe（GUI 程序），不再经过 npx.cmd，否则会多留一个黑色命令行窗口
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  start "" /min cmd /c npx electron .
)
exit
