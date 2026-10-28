@echo off
chcp 65001 >nul
cd /d "%~dp0"
title maMaisonConnectee
if not exist ".venv\Scripts\python.exe" (
  echo Preparation de la console...
  python -m venv .venv
  if errorlevel 1 (
    echo Python est introuvable. Installez Python 3, puis relancez ce fichier.
    pause
    exit /b 1
  )
)
call ".venv\Scripts\activate.bat"
python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo L'installation a echoue. Verifiez la connexion, puis relancez.
  pause
  exit /b 1
)
set PYTHONUTF8=1
set MAISON_OPEN_BROWSER=1
echo Laissez cette fenetre ouverte pendant l'utilisation.
python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
echo La console s'est arretee.
pause
