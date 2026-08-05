# Warden — API debug agent

**Warden** is Mendpoint’s source grounded API repair agent. It inspects an exact repository snapshot, prepares a private candidate, and reruns an approved verification profile until the API-related bug is fixed or the attempt budget is exhausted.

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
- Exact tenant, snapshot, revision, manifest, and lease binding
- Read before write plus content fences for every mutation
- Human approval required after candidate integrity validation
- Candidate expiry uses the earlier of snapshot expiry and the configured retention limit

## API

```http
POST /agent/runs
Idempotency-Key: unique-request-id
Content-Type: application/json

{
  "goal": "Fix 404 chargess and rename amount_cents to amount",
  "consumerId": "consumer-id",
  "allowedChangedPaths": ["client.js"],
  "verifyCommand": "node check.mjs",
  "errorLog": "HTTP 404 /v1/chargess",
  "maxSteps": 20,
  "useLlm": false
}

GET /agent/runs
GET /agent/runs/:id
GET /agent/runs/:id/candidate

POST /agent/runs/:id/candidate/review
Content-Type: application/json

{ "decision": "approve" }
{ "decision": "reject" }
```

`Idempotency-Key` is required and must contain 8 to 128 safe characters. Reusing the
same key with the same request returns the existing run with `replayed: true`. Reusing
it with a different request returns 409. Browser retries retain the same key until the
request content changes.

Every run queues as an `agent.run` job. In production, the worker requires an exact,
unexpired repository snapshot and a stored verification policy. It proves the snapshot
manifest, copies the source into a private candidate, permits changes only to the exact
paths in `allowedChangedPaths`, and reruns the target, regression, and security checks.
The source snapshot is never the mutation target. Successful candidates remain review
only and are not merged automatically. Candidate reads and approvals recheck the source
and candidate digests, the complete candidate manifest, changed paths, tenant storage
boundaries, artifact presence, and expiry. Review requires a human role with `plan:edit`.
Machine agent roles cannot approve their own work.

Candidate states are `queued`, `retrying`, `candidate_ready`, `candidate_approved`,
`candidate_rejected`, `candidate_expired`, `no_action`, and `failed`. A repeated review
with the same decision is idempotent. An opposite decision returns 409. An expired
candidate returns 410 and moves to durable cleanup. Rejection and expiry cleanup are
retried by periodic worker maintenance until the private workspace and evidence files
are removed.

The worker owns execution, lease renewal, bounded retry scheduling, evidence persistence,
and dead letter handling. For local development, drain with:

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
set LLM_AGENT_MODEL=...
```

The configured planner receives the first planning turn. Repository source is excluded
from model requests unless an operator also configures
`MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED=1`, an exact tenant allowlist in
`MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS`, and `MENDPOINT_WARDEN_MODEL_PROVIDER`. Source
excerpts are redacted before request limits are applied. Ambiguous credential material is
excluded rather than partially disclosed.

## vs `@mendpoint/repair`

| | Repair | **Warden** |
|--|--------|----------------|
| Style | Batch diagnose → plan → apply | Source grounded multi-step tool loop |
| Scope | Migration leftovers + CI log | Broader API client bugs |
| Exploration | Limited tree scan | Active search/read/edit |

Use **repair** after migration PRs. Use **Warden** for open-ended “this API integration is broken” tickets.

Package entry: `runWarden` (alias `runApiBugAgent`) from `@mendpoint/agent`.
