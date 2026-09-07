@echo off
REM Windows: double-click to start the StageDrums server and open the app.
cd /d "%~dp0"
start "" http://localhost:8080
node server.js
