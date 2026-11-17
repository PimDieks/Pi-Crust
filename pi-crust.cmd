@echo off
rem Start Pi Crust. Usage: pi-crust [repo-path]
rem Thin wrapper so "pi-crust" works from cmd.exe and PowerShell. The work is in pi-crust.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pi-crust.ps1" %*
exit /b %ERRORLEVEL%
