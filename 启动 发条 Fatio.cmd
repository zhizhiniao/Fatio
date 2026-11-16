@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing Fatio dependencies...
  call npm ci --no-fund --no-audit
  if errorlevel 1 goto failed
  call node node_modules\electron\install.js
  if errorlevel 1 goto failed
)
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
:failed
pause
exit /b 1
