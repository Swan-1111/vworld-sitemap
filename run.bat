@echo off
REM ---------------------------------------------------------------
REM  Site Analysis launcher
REM
REM  Works whether this folder is the repository root (tool-only
REM  distribution) or a subfolder of a larger repository.
REM
REM  IMPORTANT: keep this file ASCII-only.
REM  cmd.exe parses .bat in the system codepage (CP949 on Korean
REM  Windows). UTF-8 Korean text here breaks the parser.
REM  All Korean messages are printed from Python instead.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

where python >nul 2>&1
if errorlevel 1 goto nopython

REM Locate requirements.txt: repo root may be here or two levels up.
set REQ=
if exist "requirements.txt" set REQ=requirements.txt
if not defined REQ if exist "..\..\requirements.txt" set REQ=..\..\requirements.txt
if not defined REQ goto start

REM First run on a new PC: install packages once.
if not exist ".setup_done" goto setup
goto start

:setup
echo.
echo   First run - installing required packages.
echo   This takes a few minutes. Please wait.
echo.
python -m pip install --disable-pip-version-check -q -r "%REQ%"
if errorlevel 1 goto pipfail
echo done > ".setup_done"
echo.
echo   Packages installed.
echo.
goto start

:pipfail
echo.
echo   [ERROR] Package install failed.
echo   Run this manually in this folder and read the message:
echo       python -m pip install -r "%REQ%"
echo.
goto done

:nopython
echo.
echo   [ERROR] Python not found in PATH.
echo   Install Python 3.11 or newer from https://www.python.org/downloads/
echo   and turn on "Add python.exe to PATH" during setup.
echo.
goto done

:start
python web.py

:done
echo.
pause
endlocal
