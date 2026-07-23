@echo off
setlocal
cd /d "%~dp0"

py -m venv .venv
if errorlevel 1 exit /b 1

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r generator\requirements.txt
python generator\database_generator.py init

 echo.
echo Setup complete. Run build.bat to generate the database.
endlocal
