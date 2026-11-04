#!/bin/sh
cd "$(dirname "$0")"
export PYTHONUTF8=1
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
python3 -m pip install -q -r requirements.txt
exec python3 lancer.py
