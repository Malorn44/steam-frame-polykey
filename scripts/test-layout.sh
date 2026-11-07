#!/usr/bin/env bash
# One bundled layout's own checks, as CI's `test:layout:<id>` job runs them: it loads on its own and is as
# wide as it should be (sidecar/tests/test_layout.py), its keys draw labels and type what they show
# (tests/layout.test.ts). Usage: npm run test:layout -- ja/flick
set -euo pipefail

id=${1:-}
if [[ ! $id =~ ^[a-z0-9-]+/[a-z0-9-]+$ ]]; then
  echo "usage: npm run test:layout -- <layout id, e.g. ja/flick>" >&2
  exit 2
fi
export POLYKEY_LAYOUT=$id
.venv/bin/python -m pytest sidecar/tests/test_layout.py -q
node_modules/.bin/vitest run tests/layout.test.ts
