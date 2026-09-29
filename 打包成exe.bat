@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
if not exist node_modules call npm install --registry=https://registry.npmmirror.com
call npm run dist
echo.
echo 打包完成，exe 在 release 文件夹里
pause
