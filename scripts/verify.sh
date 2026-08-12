#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

run_check() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run_check npm run typecheck
run_check npm test
run_check npm run build
run_check npm run ga:check
run_check git diff --check

printf '\nVerification complete.\n'
