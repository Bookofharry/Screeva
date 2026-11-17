@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0dist\apps\server\src\launcher\register-windows.js"
pause
