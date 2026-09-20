@echo off
setlocal
if defined BEND_BUN goto configured
where bun.exe >nul 2>nul
if not errorlevel 1 (
  set "BEND_BUN=bun.exe"
  goto configured
)
if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  set "BEND_BUN=%USERPROFILE%\.bun\bin\bun.exe"
  goto configured
)
if exist "%~dp0.tmp\bun-windows-x64\bun.exe" (
  set "BEND_BUN=%~dp0.tmp\bun-windows-x64\bun.exe"
  goto configured
)
echo Bend needs Bun. Install Bun or set BEND_BUN to the full path to bun.exe. 1>&2
exit /b 1
:configured
"%BEND_BUN%" "%~dp0bend2\main.ts" %*
exit /b %errorlevel%
