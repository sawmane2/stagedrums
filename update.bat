@echo off
REM Windows: double-click to update StageDrums to the latest version on GitHub.
cd /d "%~dp0"
node server.js --update
pause
