# Phase B — Trust + repeatability

Phase B hardens the vertical slice from Phase A so teams can trust merges and measure outcomes.

## Delivered

| Item | Implementation |
|------|----------------|
| **LLM confirm (medium only)** | `packages/code-impact/src/llm-confirm.ts` — budgeted (`LLM_CONFIRM_MAX`, default 12), slice-only prompts, OpenAI-compatible + xAI |
| **Offline heuristic mode** | `LLM_CONFIRM_MODE=heuristic` or `LLM_CONFIRM=1` without keys — deterministic hybrid path for CI |
| **TS compiler front-end** | `packages/codebase-index/src/ts-frontend.ts` via `typescript` API when indexing `.ts/.tsx` |
| **Policy engine** | `@mendpoint/policy` — **no auto-merge by default**, path denylist (`.env`, `prod/`, lockfiles, secrets), two-reviewer label for auth |
| **Pipeline enforcement** | `runChangePipeline` evaluates policy before open PR; blocked paths never committed |
| **Instrumentation** | `GET /metrics` + `/metrics` dashboard — opened/merged/closed, merge rate, close-without-merge, median TTM, real PR count |

## Env

```bash
# Enable live LLM confirm (medium-confidence only)
$env:LLM_CONFIRM="1"
$env:XAI_API_KEY="..."          # or OPENAI_API_KEY
# $env:LLM_CONFIRM_MODEL="grok-3-mini"
# $env:LLM_CONFIRM_MAX="12"

# CI / no keys
$env:LLM_CONFIRM_MODE="heuristic"
```

## Policy defaults

- `autoMergeLowRisk: false` always unless consumer policy explicitly sets true  
- Never touch: `.env*`, `secrets/`, `prod/`, `terraform/`, lockfiles, PEM/keys  
- Auth/security findings → `needs-two-reviewers` label in PR body  
- `notificationsOnly` can disable PR open entirely  

Seed / DB keys (JSON in `policies` table):

- `auto_merge_low_risk`  
- `never_touch_paths` (string array)  
- `notifications_only`  

## Metrics

```bash
npm run dev:api
# GET http://localhost:3001/metrics
npm run dev:web
# http://localhost:3000/metrics
```

## Commands

```bash
npm test -w @mendpoint/policy -w @mendpoint/code-impact
npm run phase-a:harness   # still valid
npm run phase-a           # real PR path from Phase A
```

## Still not Phase C

- Continuous vendor change feed  
- Full GitHub App OAuth install UI  
- Go/Java/Ruby  
- Production multi-tenant SaaS auth  
