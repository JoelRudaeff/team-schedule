@echo off
rem Runs npm with the portable Node.js that lives in .tools\node (Node is not installed system-wide).
rem Usage:  npmw run dev      npmw test      npmw run dist
setlocal
set "PATH=%~dp0.tools\node;%PATH%"
call npm %*
exit /b %ERRORLEVEL%
