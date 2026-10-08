@echo off
if exist "%~dp0services\valhalla\data\build-info.json" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0services\valhalla\start.ps1"
    if errorlevel 1 (
        pause
        exit /b 1
    )
)
cd /d "%~dp0backend"
if not exist node_modules call npm install
call npm start
