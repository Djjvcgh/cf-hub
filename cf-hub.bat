@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 LTS is required. Install it and try again.
  pause
  exit /b 1
)
node.exe "%~dp0src\launch-dashboard.js"
set "CF_HUB_EXIT=%ERRORLEVEL%"
if not "%CF_HUB_EXIT%"=="0" pause
exit /b %CF_HUB_EXIT%
