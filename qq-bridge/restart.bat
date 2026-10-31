@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping old guard windows...
rem 2026-10-30: match patterns kept ASCII-only on purpose - %~dp0 contains non-ASCII
rem path segments that cmd mangles under GBK, silently breaking the process kills.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
rem node is launched as `node src/bridge.js` (forward slash) - a backslash pattern never matches
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
rem ping-based delay: coreutils timeout on PATH shadows cmd's timeout under some shells
ping -n 3 127.0.0.1 >nul
del state\bridge.lock 2>nul
if exist "%~dp0start-hidden.vbs" (wscript.exe "%~dp0start-hidden.vbs") else (start "" cmd /c start.bat)
echo Guard window started.
