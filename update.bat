@echo off
REM ---------------------------------------------------------------
REM  Pull the latest beta and reinstall packages if needed.
REM
REM  Works whether this folder is the repository root (tool-only
REM  distribution) or a subfolder of a larger repository:
REM  git commands work from any folder inside a clone.
REM
REM  IMPORTANT: keep this file ASCII-only (cmd parses .bat in CP949).
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

where git >nul 2>&1
if errorlevel 1 goto nogit

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto norepo

REM Locate requirements.txt: repo root may be here or two levels up.
set REQ=
if exist "requirements.txt" set REQ=requirements.txt
if not defined REQ if exist "..\..\requirements.txt" set REQ=..\..\requirements.txt

echo.
echo   Checking for updates...
echo.
git fetch --quiet
if errorlevel 1 goto netfail

for /f %%i in ('git rev-list --count HEAD..@{u} 2^>nul') do set BEHIND=%%i
if "%BEHIND%"=="" set BEHIND=0
if "%BEHIND%"=="0" goto uptodate

echo   %BEHIND% new update(s):
echo.
git log --oneline HEAD..@{u}
echo.

REM Did the package list change? Check before pulling.
set NEEDPIP=0
if defined REQ (
    git diff --quiet HEAD @{u} -- "%REQ%" 2>nul
    if errorlevel 1 set NEEDPIP=1
)

git pull --ff-only
if errorlevel 1 goto conflict

echo.
echo   Updated.
if "%NEEDPIP%"=="1" (
    echo   Package list changed - reinstalling...
    python -m pip install --disable-pip-version-check -q -r "%REQ%"
)
echo.
echo   Done. Start the app with run.bat
goto done

:uptodate
echo   Already up to date.
git log -1 --oneline
goto done

:conflict
echo.
echo   [ERROR] Could not update automatically.
echo   Files here were modified locally.
echo.
echo   If you have no local work to keep, discard and retry:
echo       git reset --hard @{u}
echo.
echo   Your .env and out\ folder are NOT tracked by git and stay safe.
goto done

:netfail
echo.
echo   [ERROR] Could not reach the server. Check your internet connection.
echo   For a private repository you also need access permission.
goto done

:norepo
echo.
echo   [ERROR] This folder is not a git clone, so it cannot auto-update.
echo   Get the repository address and use:
echo       git clone ^<address^>
echo   Copying the folder by hand never receives updates.
goto done

:nogit
echo.
echo   [ERROR] git not found in PATH.
echo   Install Git for Windows: https://git-scm.com/download/win
goto done

:done
echo.
pause
endlocal
