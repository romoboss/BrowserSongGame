@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" generator\database_generator.py build %*
) else (
  py generator\database_generator.py build %*
)

endlocal
