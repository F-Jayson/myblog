@echo off
setlocal
where pwsh.exe >nul 2>nul
if not errorlevel 1 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
)
if errorlevel 1 (
  echo.
  echo Start failed. Review the error above.
  pause
) else (
  echo.
  echo Firefly is running. The URLs above can be opened from this window.
  echo Press any key to close this window. The services will keep running.
  pause >nul
)
endlocal
