# Agentic repair product layer

Mendpoint’s core loop opens migration PRs. The **agentic repair** layer sits on top: after a draft migration (or when CI fails), it **diagnoses → plans → applies → verifies** in a bounded loop.

## Guarantees

- **Never auto-merges**
- Path denylist (`.env`, secrets, lockfiles, …)
- Bounded attempts (default 3)
- Every session produces a human-readable markdown report
- Optional LLM only on code slices (`LLM_REPAIR=1`)

## Loop

```
seed failure log / tree scan
    → diagnose (TS errors, leftovers, FIXMEs)
    → plan (deterministic rename map + optional LLM)
    → apply edits
    → verify commands (optional)
    → repeat until green or max attempts
```

## Packages

| Package | Role |
|---------|------|
| `@mendpoint/repair` | Core repair session (`runRepairSession`) |
| `@mendpoint/pipeline` | Optional pre-PR repair (`AGENTIC_REPAIR=1`) |

## API

```http
POST /repair/sessions
{
  "consumerId": "...",
  "renameMap": { "amount_cents": "amount" },
  "verifyCommands": [],
  "maxAttempts": 3,
  "dryRun": false,
  "useLlm": false
}

GET /repair/sessions
GET /repair/sessions/:id
```

## CLI / env

```bash
# Pipeline: write migration, run repair, then open PR
set AGENTIC_REPAIR=1
set AGENTIC_REPAIR_ATTEMPTS=3
# optional hybrid LLM repairs
set LLM_REPAIR=1
set OPENAI_API_KEY=...
set OPENAI_BASE_URL=...

npm run repair:demo   # unit path via tests
```

## UI

`/repair` — pick consumer, rename map, run session, inspect report.

## What is “real” vs not

| Capability | Status |
|------------|--------|
| Deterministic repair (renames, kwargs, FIXMEs, compiler “Did you mean”) | **Shipped** |
| Multi-attempt verify loop | **Shipped** |
| Persist sessions + audit | **Shipped** |
| PR body + CI comment integration | **Shipped** |
| Optional LLM slice repairs | **Shipped** (needs keys) |
| Full Devin-class exploration of arbitrary bugs | **Out of scope** — specialized to API migration fallout |
