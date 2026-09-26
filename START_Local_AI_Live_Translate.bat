@echo off
chcp 65001 > nul
title Local AI Live Translate
cd /d "%~dp0"
echo ===================================================
echo   Local AI Live Translate - starting server...
echo ===================================================

rem Download anything missing (first run of a git clone, or new dependencies after an update):
rem a portable Python, its packages and the speech models, each checked against a pinned hash.
rem Takes well under a second when everything is already in place.
if exist "tools\setup.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\setup.ps1" || goto fail
)

set "PYEXE="
if exist "runtime\python.exe" set "PYEXE=runtime\python.exe"
if not defined PYEXE if exist "server\.venv\Scripts\python.exe" set "PYEXE=server\.venv\Scripts\python.exe"
if not defined PYEXE goto fail
echo.

rem -E -s: ignore PYTHON* environment variables and user site-packages, so another
rem Python installed on this PC can't interfere.
"%PYEXE%" -E -s server\live_translate_server.py %*
echo.
echo Server has stopped. Press any key to close.
pause
exit /b 0

:fail
echo.
echo [ERROR] Setup did not finish. Check the internet connection and run this file again.
pause
exit /b 1
