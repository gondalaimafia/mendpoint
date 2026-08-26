# Mendpoint — Codex Instructions

You are one of two coding agents working concurrently on Mendpoint.

The other engineering agent is Claude Code.

## Required reading

Before substantive work, read:

1. `docs/agents/OPERATING_PROTOCOL.md`
2. `docs/agents/FAILURE_MODES.md` — the defects that have actually shipped here, and the checks that catch them
3. `REVIEW.md`
4. `docs/agents/SECURITY_BOUNDARIES.md`
5. relevant sections of `docs/product/mendpoint-product-platform-specification-v4.md`
6. applicable ADRs
7. the current GitHub issue

## Canonical products

- **Fettler:** external API/SDK/provider-change remediation
- **ReGauge:** internal and legacy modernization

Use these names consistently.

## Author mode

When you are AUTHOR:

- use an isolated worktree
- use `codex/<issue>-<slug>`
- never modify a Claude-owned branch
- inspect open issues/PRs for overlap before coding
- push only your own task branch
- make the smallest coherent change
- run relevant tests
- open/update a PR
- request independent Claude peer review

## Reviewer mode

When reviewing another agent's PR:

- remain independent
- do not modify the author's branch
- follow `REVIEW.md` and `docs/agents/FAILURE_MODES.md`
- inspect affected behavior beyond changed lines — trace the live production caller
- verify product/architecture contracts
- identify concrete, evidence-backed findings
- re-review after substantive changes

## Independent review

Codex-authored material PRs require Claude review.

Preferred GitHub request:

`@claude review`

If that exact trigger is unavailable, use the installed Claude review mechanism.

## Engineering behavior

Prefer:

- root-cause fixes
- minimal coherent diffs
- deterministic mechanisms where appropriate
- regression tests
- explicit error handling
- backward compatibility
- evidence-backed architecture
- safe failure and rollback

Do not:

- make unrelated refactors
- weaken tests
- hide failures
- commit secrets
- bypass review
- bypass CI
- silently change architecture
- push to another agent's feature branch

## Mendpoint high-risk areas

Treat changes to these areas as high risk:

- authentication/authorization
- tenant isolation
- consent/residency
- repository credentials
- Change Graph construction/query semantics
- Fettler impact detection/remediation
- ReGauge migration planning/execution
- verification
- model router
- learning capture/datasets
- training/adapters
- promotion/canary/rollback
- persistence/migrations
- production infrastructure

## Code-review expectations

Before reviewing a PR, read `REVIEW.md`.

Prioritize correctness over style. Report concrete, evidence-backed findings.

Pay particular attention to:

- behavior regressions
- architectural violations
- edge cases
- tenant isolation
- persistence correctness
- concurrency/races
- idempotency
- failure recovery
- rollback
- migration safety
- compatibility
- tests
- hidden coupling
- model/router correctness
- graph correctness
- learning-data provenance

Do not approve merely because tests pass.

## Before finishing author work

Always:

1. inspect the complete diff
2. run relevant tests
3. verify no unintended files/secrets
4. sync with the intended base
5. summarize what changed and why
6. list tests executed
7. list unresolved risks
8. open/update the PR
9. request independent Claude peer review (`@claude review`)
10. do not merge a Codex-authored material PR solely on your own authority. Claude/Cursor Cloud-authored PRs: after independent Claude PASS and required CI green, merge only if closure contexts are green; if they are red, escalate — do not admin-override. Deploy is the `main` `deploy` job.

## Cursor Cloud specific instructions

Durable, non-obvious notes for Cloud Agents. Standard commands live in `README.md` and the root `package.json` scripts.

- **Node runtime (critical):** This repo requires the latest Node 22.x (CI uses `node-version: "22"`). `packages/db` relies on `node:sqlite`'s `isTransaction`, which is absent from Node 22.14.0. On a stale runtime, SQLite-backed tests fail with `cannot start a transaction within a transaction` and the API crashes at boot. The Cloud environment provides Node 22.23.2 as the default `node`/`npm`/`npx`; if `node --version` ever reports 22.14.0 you are on the stale platform runtime — use a login shell (or the nvm 22.x bin) before running tests/servers.
- **Running the API in dev:** `npm run dev:api` (port 3001) fails to boot unless `MENDPOINT_APPLICATION_DATA_KEY` is set to a distinct 32-byte key — `MENDPOINT_APPLICATION_DATA_KEY=$(openssl rand -hex 32) npm run dev:api` works for local dev. In dev, API auth is `off` (header identity such as `x-tenant-id`/`x-role` is accepted); it becomes `required` under `NODE_ENV=production`.
- **Running the web dashboard in dev:** `npm run dev:web` (port 3000) serves public pages without auth, but operator dashboards require `MENDPOINT_WEB_ACCESS_TOKEN` (any non-empty value locally) plus `MENDPOINT_API_URL=http://127.0.0.1:3001`. Sign in at `/access` with that token.
- **Seed/demo (offline):** `npm run db:seed` populates `data/mendpoint.sqlite`; `npm run demo` runs the full change→impact→PR pipeline with no network.
- **Fettler campaign execute:** `run-service` / `run-jobs` only claim `warden.campaign.execute-target` when `GRAPH_LEARN_DB` points at an existing non-ephemeral Change Graph file. `POST /fettler/campaigns/:id/start` still enqueues; jobs wait until a worker with a real graph is up. Never pass `openGraphLearnMemory()` or `getGraphLearnDb()` (creates a missing file) as a production handle.
- **Review, merge, deploy:** Request `@claude review` (independent Claude instance), not `@codex review`. The review comment must include this run's identity (Cursor Cloud run URL / `bcId`). After Claude `PEER REVIEW: PASS` and required CI green (`test`, `release-gates`, `container-builds`, `deployment-e2e`), merge only if closure-authority contexts are also green. If they are red, escalate to the operator — do not admin-override. Production deploy is the `CI` `deploy` job on push to `main`. Until a distinct reviewer actor is bound, Claude-owned work stays out of the release-train matrix.
- **Not done until (hard):** A change is not finished if any of these is missing:
  1. `docs/agents/FAILURE_MODES.md` was applied as a pre-flight (third-state, delete-the-check, reachable live caller, CI-scope gates).
  2. The production caller is traced (`apps/api/src/server.ts` route, `apps/worker/src/cli.ts` job branch, or a named CLI command) and the new control actually changes that path — a helper return the caller ignores is not a gate.
  3. Tests cover that live caller, not only the new helper with a fixture that invents the world production never produces.
  4. The same package suite CI runs was executed (not only the new test file). `scripts/` and `evals/` are not npm workspaces; a workspace-scoped command skips them.
  5. At least one test goes red if the new control is deleted (mutation check; do this, do not reason about it).
  6. The branch is rebased onto current `origin/main` and the contract-sensitive tests were re-run on the rebased tree.
  7. `CHANGES REQUIRED` on a related PR was treated as a stop-the-line, not as a reason to open the next wave.
