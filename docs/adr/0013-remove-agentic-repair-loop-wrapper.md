# ADR-0013: Remove the agentic repair loop wrapper and the ci-loop package

- **Status:** Accepted
- **Date:** 2026-08-21
- **Author:** Claude Code
- **Supersedes:** none
- **Superseded by:** none

## Context

`packages/repair/src/loop.ts` defined `runAgenticRepairLoop`, a wrapper that
orchestrated a verify -> repair -> verify pass by combining three things: an
initial `runCiLoop` to seed a failure log, a `runRepairSession` to make the
actual mutations, and a final advisory `runCiLoop` plus a PR comment posted
through `postCiCheck`. `runCiLoop` itself lived in a separate package,
`@mendpoint/ci-loop` (`packages/ci-loop/src/index.ts`), a generic
run-commands-and-retry loop.

Re-verified against `main` at commit
`7e85729fb1171bc62c3ae92e0f76ef908cad7e75` (the parent of the removal commit):

- `runAgenticRepairLoop` had **zero non-test callers**. It was referenced only by
  `packages/repair/src/session.test.ts` and the barrel re-export at
  `packages/repair/src/index.ts`. No `apps/`, `packages/`, `scripts/`, `evals/`,
  `demo/`, `.mjs` deploy script, `fly.*.toml`, or workflow referenced it.
- `runCiLoop` (the `@mendpoint/ci-loop` export) had **zero non-test callers other
  than `loop.ts` itself**, and `@mendpoint/ci-loop` was a dependency of exactly one
  package, `@mendpoint/repair`, used only by `loop.ts`.

The live CI-repair path does not go through this wrapper. There are two live
repair paths and both bypass it:

1. **The governed, tenant-scoped CI-repair work unit.**
   `apps/worker/src/warden-ci-repair-dispatch.ts` (`runWardenCiRepairDispatch`),
   driven by the `fettler_ci_cycles` machine in
   `packages/db/src/warden-ci-reentry.ts`, validates a `warden.candidate.repair`
   job against a budget-bounded cycle, reads the CI-failure evidence, materializes
   an immutable snapshot, and enqueues an `agent.run` job. The Fettler agent then
   does the verify -> repair -> verify iteration inside a governed, budgeted,
   snapshot-bound sandbox. This is the only working multi-step Fettler CI work unit.
2. **The direct repair-session path.** `POST /repair/sessions`
   (`apps/api/src/server.ts`) enqueues a `repair.run` job, which the worker
   (`apps/worker/src/cli.ts`) executes by calling `runRepairSession` directly. The
   pipeline campaign executor (`packages/pipeline/src/index.ts`) likewise calls
   `runRepairSession` directly.

`runAgenticRepairLoop` is therefore a second, ungoverned implementation of the
same verify -> repair -> verify loop: no tenant scope, no budget from a cycle, no
snapshot binding, no governance. It duplicates the live loop concept without the
guarantees the live paths carry, and nothing invokes it.

The docs claimed more than the code delivered. `docs/AGENTIC_REPAIR.md` advertised
`@mendpoint/ci-loop` as a shipped "Verify / comment scaffold" and documented a
`"agenticLoop": false` field on `POST /repair/sessions`. That field does not exist
anywhere in the codebase: the route reads only `consumerId`, `renameMap`,
`maxAttempts`, `dryRun`, and `useLlm`. The dead wrapper had accreted a public-doc
claim for a capability its only implementation never reached production for.

## Decision

We remove `runAgenticRepairLoop` (`packages/repair/src/loop.ts`) and its barrel
re-export from `packages/repair/src/index.ts`. Because removing the wrapper strands
`@mendpoint/ci-loop` (its only remaining consumer), we also remove that package in
full — `packages/ci-loop/` and the `@mendpoint/ci-loop` dependency line in
`packages/repair/package.json` — rather than leave a well-tested, unreachable
package behind. Two implementations of the same loop are worse than one; leaving
half the second implementation is worse still.

We **keep** `runRepairSession` and every other `@mendpoint/repair` export
(`diagnoseFailureLog`, `planRepairs`, `applyActions`, `runVerificationCommand`,
`runVerificationInSandbox`, and the shared types). These are live: the worker
`repair.run` handler, the pipeline campaign executor, and the Fettler agent all
depend on them. Only the dead wrapper and its dead lower-level loop go.

We update `docs/AGENTIC_REPAIR.md` to match reality: the `@mendpoint/ci-loop` row
is removed, the `@mendpoint/repair` role is stated as the core repair session, and
the fictional `"agenticLoop"` request field is dropped from the API example.

The single test that exercised the wrapper — a dry-run "simulated, never claims
verification" assertion in `session.test.ts` — is re-pointed at `runRepairSession`
directly, since that is where the simulated behaviour actually lives; the coverage
is preserved, not deleted.

### Why removing beats leaving it

A fully tested, uncalled loop wrapper reads as an available, production-ready
capability. The next engineer wiring CI-driven repair would reasonably find
`runAgenticRepairLoop` (its name and shape are exactly what they would search for)
and build on it — inheriting an ungoverned, unbudgeted, non-tenant-scoped loop as
if it were the real path, in parallel to the governed `warden-ci-repair-dispatch`
path that already exists. Deleting it removes the trap and collapses the codebase
back to one repair loop.

## Alternatives considered

- **Leave it with a "not wired" comment.** Rejected. The confusion is that the code
  looks ready; a comment does not stop someone importing and extending it, and a
  second loop implementation keeps paying typecheck and maintenance cost.
- **Remove the wrapper but keep `@mendpoint/ci-loop`.** Rejected. It would leave a
  well-built, tested package with zero non-test callers — the exact "available
  infrastructure that nothing reaches" state this work is removing.
- **Wire `runAgenticRepairLoop` into the live path.** Rejected. It duplicates the
  governed `warden-ci-repair-dispatch` path with weaker guarantees; wiring it would
  create two competing repair loops, which is precisely what "two implementations
  is worse than one" warns against.

## Security impact

None. The removed code had no production callers, so no authentication,
authorization, tenancy-isolation, secret-handling, or attack-surface behaviour
changes. The governed CI-repair path (budget-bounded, snapshot-bound,
tenant-scoped) is untouched and remains the only live multi-step repair work unit.

## Data and compatibility impact

No persistence contract or wire format is affected; the wrapper wrote no durable
state. The `@mendpoint/repair` public surface loses only `runAgenticRepairLoop`
and its input/result types (`AgenticRepairLoopInput`, `AgenticRepairLoopResult`),
which had no external consumer. The `@mendpoint/ci-loop` package is removed
entirely; it was an internal workspace dependency with no external consumer.

## Migration plan

1. Re-point the wrapper's one test at `runRepairSession`.
2. Delete `packages/repair/src/loop.ts` and its barrel export.
3. Delete `packages/ci-loop/` and drop the `@mendpoint/ci-loop` dependency from
   `packages/repair/package.json`; regenerate `package-lock.json` via `npm install`.
4. Reconcile `docs/AGENTIC_REPAIR.md`.
5. Run `npm run typecheck` across all workspaces; a clean pass is the evidence that
   no live code depended on the removed wrapper or package.

The change is backward compatible for every live path; there is no dual-write
window or backfill because there was never a live caller.

## Rollback

Both are fully recoverable from git history. They last existed intact at
`7e85729fb1171bc62c3ae92e0f76ef908cad7e75` (the parent of the removal commit).
Restoring is `git checkout 7e85729 -- packages/repair/src/loop.ts packages/ci-loop`
plus re-adding the barrel export and the `@mendpoint/ci-loop` dependency line, then
`npm install`. Rollback is clean at any time because the removal changes no
persisted data and no live behaviour.

## Evaluation plan

Success is a clean `npm run typecheck` across all workspaces and a green
`npx vitest run packages/repair` after the deletion, proving nothing depended on
the removed wrapper or package.

### What would need to be true to justify rebuilding it

The decision is "not yet," not "never." A standalone, ungoverned repair loop
becomes justified only if there is a concrete need for a repair path **outside**
the governed Fettler work unit — for example a local developer or CI harness that
must run verify -> repair -> verify against a working tree without a tenant,
budget, or snapshot binding, and where posting a PR comment from that harness is a
real requirement. If that need appears, restore the wrapper (or, better, build a
thin harness over the live `runRepairSession`) from the commit above and wire it
deliberately, rather than rediscovering it by accident.
