#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python generator/database_generator.py build "$@"
else
  exec python3 generator/database_generator.py build "$@"
fi
