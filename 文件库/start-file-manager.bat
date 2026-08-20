@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem Windows Task Scheduler entry point for Lantern File Manager.
rem Recommended trigger: At startup, with a 30-second delay.
rem Recommended account: SYSTEM, run whether a user is logged on or not.

cd /d "%~dp0"

set "LOG_DIR=%~dp0data"
set "LOG_FILE=%LOG_DIR%\server-startup.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE="
  for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
)

if not defined NODE_EXE (
  echo [%date% %time%] ERROR: node.exe was not found.>>"%LOG_FILE%"
  exit /b 2
)

set "APP_PORT="
for /f "usebackq delims=" %%P in (`"%NODE_EXE%" -p "require('./config.json').port" 2^>nul`) do set "APP_PORT=%%P"
if not defined APP_PORT set "APP_PORT=8787"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [%date% %time%] INFO: port %APP_PORT% is already listening; startup skipped.>>"%LOG_FILE%"
  exit /b 0
)

echo [%date% %time%] INFO: starting Lantern File Manager on port %APP_PORT%.>>"%LOG_FILE%"
"%NODE_EXE%" "%~dp0server.js" >>"%LOG_FILE%" 2>&1
set "APP_EXIT=%errorlevel%"
echo [%date% %time%] ERROR: Lantern File Manager exited with code %APP_EXIT%.>>"%LOG_FILE%"
exit /b %APP_EXIT%
