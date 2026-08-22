# ADR-0011: Remove the policy router runtime nothing calls

- **Status:** Accepted
- **Date:** 2026-08-21
- **Author:** Claude Code
- **Supersedes:** none
- **Superseded by:** none

## Context

`packages/platform/src/router-runtime.ts` defined `PolicyRouterRuntime`, a durable
envelope and evidence-store runtime for policy-routed execution. It implemented a
substantial capability set:

- **Durable policy envelopes** (`RouterPreparedEnvelope`): a frozen, content-addressed
  record of a routing decision, its policy snapshot, executor and availability
  snapshots, retry policy, eligible and excluded executors, and cost/latency estimates.
- **An evidence store** with an append-only, hash-chained event log in two
  implementations, `InMemoryRouterEvidenceStore` and `JsonlRouterEvidenceStore`, both
  failing closed on a broken chain.
- **Replay**: `replay()` re-derived the decision from the frozen snapshot and confirmed
  the decision id and envelope id reproduced byte-for-byte, including the adaptive
  history snapshot.
- Attempt recording, idempotent outcome capture, policy-bound retry and fallback
  selection, and human-handoff finalization.

It was well built and fully tested. It was also never wired to a production path. An
archaeology pass, re-verified against `main` at commit
`2a1763ab6fabaeae782860f0b16a284c13d0f33b`, found `PolicyRouterRuntime` and both
evidence stores instantiated **only** in `router-runtime.test.ts` — zero non-test
callers across `packages/`, `apps/`, `scripts/`, `evals/`, and `demo/`, and no barrel
re-export reached by any live consumer. The de-duplication work in #258 and the
Context Compiler both touched adjacent ground without picking it up.

The live routing path does not depend on it. Policy evaluation happens in
`evaluateExecutor` / `routeTask` (`packages/platform/src/router.ts`), and the live
routed-execution entry point is `runPolicyRoutedWarden`
(`packages/agent/src/routed-agent.ts`), driven from the worker CLI with a port supplied
by `createWardenRoutingRuntime` (`apps/worker/src/warden-router.ts`). None of these
import `router-runtime.ts` or construct `PolicyRouterRuntime`.

This repository carries roughly a dozen subsystems in the built-but-uncalled state, and
it is the pattern that has caused the most confusion. `PolicyRouterRuntime` is
particularly hazardous: it implements exactly the capability someone would reach for
when making the policy envelope inheritable, so it would be found, trusted, and wired by
someone who did not know it had never been exercised outside its own tests.

## Decision

We will remove `PolicyRouterRuntime`, its two evidence stores
(`InMemoryRouterEvidenceStore`, `JsonlRouterEvidenceStore`), the `RouterEvidenceStore`
interface, `PrepareRouterRuntimeInput`, `RouterRuntimeDisposition`,
`RouterEvidenceEnvelope`, `RouterFinalOutcome`, and every private helper that existed
solely to serve the runtime. We will delete `router-runtime.test.ts`, which tested only
those symbols, and drop the removed symbols from the `@mendpoint/platform` barrel.

We will **keep** `router-runtime.ts` as a types-only contract module. The evidence-record
types `RouterEvidenceEvent`, `RouterPreparedEnvelope`, and `RouterAttemptEvidence` are
imported by the live adaptive-routing aggregation in `router-adaptive.ts` (consumed in
turn by `router.ts`), so they, and their transitive type dependencies
(`RouterDispatch`, `RouterActualOutcomeInput`, `RouterVerificationEvidence`,
`RouterRetryPolicy`, `PersistedRouterTaskSpec`, and the internal `SerializableRoute`),
stay. Removing a type shared with live code is out of scope; only the dead runtime goes.

We will **not** touch `evaluateExecutor`, `routeTask`, `runPolicyRoutedWarden`,
`createWardenRoutingRuntime`, or `router-adaptive.ts`.

### Why removing beats leaving it

A well-built, fully tested, uncalled module reads as available infrastructure. The next
engineer to open `PolicyRouterRuntime` while making the policy envelope inheritable would
reasonably assume it works in production and build on it — inheriting an unexercised
durable-storage and replay path as if it were load-bearing. This repository has been
bitten by exactly that failure mode repeatedly. Deleting the runtime removes the trap;
leaving a comment would not, because the hazard is precisely that the code looks ready.

## Alternatives considered

- **Leave it in place, add a "not wired" comment.** Rejected. The confusion comes from
  the code looking production-ready; a comment does not stop someone from importing and
  extending a well-built class, and dead code still pays typecheck and maintenance cost.
- **Wire it into the live path now.** Rejected. The runtime persists policy envelopes and
  evidence per routing decision, but there is no tenant-scoped policy store to make that
  meaningful today (see below). Wiring an unexercised durable path into production
  without the surrounding storage model is how latent runtimes become latent incidents.
- **Delete the whole file, including the shared types.** Rejected. `router-adaptive.ts`
  (live) imports three of these types directly; removing them would break the adaptive
  aggregation or force type churn across a module outside this decision's scope.

## Security impact

None. The removed code had no production callers, so no authentication, authorization,
tenancy-isolation, secret-handling, or attack-surface behavior changes. If anything, the
attack and maintenance surface shrinks: an unexercised append-only file store
(`JsonlRouterEvidenceStore`, which wrote and parsed JSONL from disk) is no longer part of
the shipped package.

## Data and compatibility impact

No persistence contract or wire format is affected, because nothing in production ever
produced or consumed the evidence log. The `@mendpoint/platform` public surface loses the
runtime, the two stores, the `RouterEvidenceStore` interface, and four runtime-only types
from the barrel; none had an external consumer. The surviving evidence-record types stay
exported, so the adaptive-routing contract is unchanged.

## Migration plan

1. Trim `router-runtime.ts` to the surviving evidence-record types.
2. Drop the removed symbols from the platform barrel (`index.ts`).
3. Delete `router-runtime.test.ts`.
4. Run `npm run typecheck` across all workspaces; a clean pass is the evidence that no
   live code depended on the removed runtime.

The change is backward compatible for every live path; there is no dual-write window or
backfill because there was never a live writer.

## Rollback

The runtime is fully recoverable from git history. It last existed intact at
`2a1763ab6fabaeae782860f0b16a284c13d0f33b` (the parent of the removal commit) and was
introduced in `bdf9709bbdce9b2132d03e6d3702def6f06411a6` ("Add bounded execution
evidence primitives"). Restoring it is `git checkout 2a1763a -- packages/platform/src/router-runtime.ts packages/platform/src/router-runtime.test.ts`
plus re-adding the barrel exports. Rollback is clean at any time because the removal
changes no persisted data and no live behavior.

## Evaluation plan

Success is a clean `npm run typecheck` across all workspaces and a green
`npx vitest run packages/platform packages/agent apps/worker` after the deletion, proving
nothing depended on the removed runtime.

### What would need to be true to justify rebuilding it

The decision is "not yet," not "never." Rebuilding `PolicyRouterRuntime` (or an
equivalent durable envelope runtime) becomes justified when there is a **tenant-scoped
policy store** to route against. Today the `policies` table is keyed on `consumer_id`, is
seed-time only, and has no API writer — so a durable per-decision envelope has no
authoritative, tenant-owned policy to bind to and no lifecycle to persist against. When a
tenant-scoped, API-writable policy store exists and a concrete product requirement needs
inheritable policy envelopes with replayable evidence, restore the runtime from the
commit above and wire it deliberately, rather than rediscovering it by accident.
