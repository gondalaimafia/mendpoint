# warden-bench (internal only)

Synthetic API-debug cases for **Warden** (`@mendpoint/agent`).  
**Not a public leaderboard.** Do not use scores in marketing or sales claims.

## Layout

```
fixtures/warden-bench/<id>/
  issue.md      # GitHub-issue style goal text (no file paths)
  repo/         # broken consumer + check.mjs
  meta.json     # { "verify": "node check.mjs", "timeoutSec": 60 }
```

## Run

```bash
npm run eval:warden
```

Or from package tests:

```bash
npm test -w @mendpoint/eval
```

## Rules

| Rule | Why |
|------|-----|
| Goal text only in `issue.md` | Simulates a ticket without pointing at files |
| `check.mjs` exits 0 only when fixed | Objective pass/fail |
| No network required | Deterministic CI |
| Internal numbers only | See `docs/WARDEN_BENCH_INTERNAL.md` |

## Cases (v0)

| ID | Bug class |
|----|-----------|
| `01-path-typo` | Wrong HTTP path (`chargess`) |
| `02-amount-field` | Field rename `amount_cents` → `amount` |
| `03-max-tokens` | Deprecated param `max_tokens` → `max_completion_tokens` |
| `04-https-upgrade` | `http://api.` → `https://api.` (SSL goal) |
| `05-idempotency` | POST missing `Idempotency-Key` (double-charge risk) |
