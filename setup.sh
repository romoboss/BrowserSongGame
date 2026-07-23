#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r generator/requirements.txt
python generator/database_generator.py init

echo
echo "Setup complete. Run ./build.sh to generate the database."
