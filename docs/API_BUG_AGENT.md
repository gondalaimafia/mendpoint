# Warden — API debug agent

**Warden** is Mendpoint’s first agentic product: a Devin-style debug agent that **explores a repo, edits code, and re-runs a verify command** until an API-related bug is fixed — or attempts are exhausted.

This is **not** a general “fix any software bug” agent. It is trained on **API communication failures**:

| Area | Examples Warden targets |
|------|-------------------------|
| Protocol / contract | Paths, Content-Type, Accept, version headers, GraphQL vs REST shape |
| Serialization | Field renames, pagination keys, enum/date/null semantics |
| Semantic | Units (cents), epoch ms vs s, docs vs live errors |
| Network | https, timeouts, request-id headers |
| Cascading errors | Backoff+jitter, 4xx vs 5xx retries, Idempotency-Key, status checks |
| Async / webhooks | Delivery dedupe, signature-related patterns |
| Rate limiting | 429 + Retry-After |

Full catalog: [`WARDEN_TRAINING.md`](./WARDEN_TRAINING.md).

## Loop

```
goal + optional error log
  → run verify (capture failure)
  → list_dir / search / read_file
  → replace_in_file | write_file
  → run_command (verify)
  → repeat until pass or maxSteps
  → finish + markdown report
```

## Tools

| Tool | Purpose |
|------|---------|
| `list_dir` | Map code files |
| `search` | Find symbols / paths |
| `read_file` | Inspect candidates |
| `replace_in_file` | Surgical edits |
| `write_file` | Full file rewrite |
| `run_command` | Verify / tests (policy-blocked dangerous cmds) |
| `http_probe` | Optional live HTTP (off by default) |
| `finish` | Stop with status |

## Safety

- Path denylist (`.env`, secrets, lockfiles, `node_modules`)
- No `..` escape from repo root
- Shell command denylist
- **Never auto-merges**
- Bounded steps (default 20)

## API

```http
POST /agent/runs
{
  "goal": "Fix 404 chargess and rename amount_cents to amount",
  "repoPath": "C:/.../fixtures/agent-bugs/broken-charges",
  "verifyCommand": "node check.mjs",
  "errorLog": "HTTP 404 /v1/chargess",
  "maxSteps": 20,
  "useLlm": false,
  "allowNetwork": false,
  "async": true
}

GET /agent/runs
GET /agent/runs/:id
```

Runs queue as `agent.run` jobs by default. The worker owns execution, lease renewal,
retry scheduling, and dead letter handling. For local development, drain with:

```bash
npm run worker:jobs
```

## UI

`/agent` — goal, path or consumer, verify command, run, trace.

## CLI / tests

```bash
npm test -w @mendpoint/agent
npm run agent:demo
# Fixture: fixtures/agent-bugs/broken-charges
```

## Optional LLM planner

```bash
set LLM_AGENT=1
set OPENAI_API_KEY=...
set OPENAI_BASE_URL=...   # or xAI-compatible
```

Heuristics run first; LLM may suggest tools after step 2.

## vs `@mendpoint/repair`

| | Repair | **Warden** |
|--|--------|----------------|
| Style | Batch diagnose → plan → apply | Multi-step tool loop (Devin-like) |
| Scope | Migration leftovers + CI log | Broader API client bugs |
| Exploration | Limited tree scan | Active search/read/edit |

Use **repair** after migration PRs. Use **Warden** for open-ended “this API integration is broken” tickets.

Package entry: `runWarden` (alias `runApiBugAgent`) from `@mendpoint/agent`.
