@echo off
REM Always run from this script's own folder, regardless of where it lives or
REM what the folder is named.
cd /d "%~dp0"
if not exist logs mkdir logs
npm start >> logs\bot.log 2>&1
