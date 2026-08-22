# ADR-0012: Remove two unreachable subsystems (`@mendpoint/billing` and `mendpoint.yaml` config-as-code)

- **Status:** Accepted
- **Date:** 2026-08-21
- **Author:** Claude Code
- **Supersedes:** none
- **Superseded by:** none

## Context

Two well-built, well-tested subsystems had zero non-test consumers anywhere in
the monorepo. A finished, tested, unreachable module reads as available
infrastructure, and this repository has repeatedly been bitten by exactly that:
the removal of `PolicyRouterRuntime` immediately exposed a second dead symbol
that had looked reachable only because its sole caller was itself unreachable.
Leaving either subsystem as-is was not an acceptable outcome — each had to be
either wired to a live path or removed.

The test applied to each: **is there a live path that would consume this today,
if it were connected?** If yes, wire it minimally to that one path. If no, remove
it, preserving any type that live code shares.

### 1 — `@mendpoint/billing`

The package (invoice boundary + state machine, mock payment collector, real
Stripe collector, tenant settlement ledger, reconciled usage evidence) was built
by PRs #64 (mock collector, aadb835) and #96 (Stripe collector, 16e8388).

Evidence of zero reach:

- `@mendpoint/billing` as a dependency specifier appeared only in its own
  `packages/billing/package.json` and the generated `package-lock.json`. No
  other workspace declared or imported it.
- A repo-wide search for its distinctive symbols (`TenantInvoiceRegistry`,
  `MockPaymentCollector`, `TenantSettlementLedger`, `StripePaymentCollector`,
  `createStripeCollectorFromEnv`, `resolvePaymentCollector`,
  `buildReconciledUsageEvidence`, `createInvoiceDraft`) and its env-var flags
  (`MENDPOINT_BILLING_COLLECTION`, `MENDPOINT_BILLING_ALLOW_LIVE`) across
  `packages/`, `apps/`, `scripts/`, `evals/`, `demo/`, `.mjs` scripts,
  `fly.*.toml`, and workflow files found only: the package's own source and
  tests, two docs, and three string-literal entries in
  `packages/shared/src/error-guidance.ts` (guidance text for errors that only
  the Stripe collector throws — data, not a code caller).
- The enable flag (`MENDPOINT_BILLING_COLLECTION`) was read only inside the
  package, so the subsystem was unreachable **even behind the flag**.

Crucially, the platform **does** have a live billing surface — but it is a
separate implementation that does not use this package. `apps/api/src/billing-economics.ts`
records actual execution costs and reconciles gross margin over `@mendpoint/db`;
`apps/api/src/billing-plan-control.ts` and the self-serve billing path settle
metered usage through the `@mendpoint/db` usage ledger and `@mendpoint/platform`
MCU metering (`reserveRunUsage` / `settleRunUsage` / entitlements). That is
usage-ledger settlement, not payment settlement. There is no invoice-generation
or payment-collection consumer anywhere. Wiring `@mendpoint/billing` would
require inventing a metering-to-invoice-to-collect surface that does not exist —
a speculative consumer, not a live path.

### 2 — `mendpoint.yaml` configuration-as-code (`packages/transformer/src/agent-config.ts`)

725 lines defining a `mendpoint.yaml` / `.json` contract — roles and
permissions, environments, coding standards, workflows and escalation — with a
fail-closed parser (`parseMendpointConfig`), a tenant-defaults-over-repo-config
layering seam (`resolveEffectiveConfig`), an explicit narrow-only invariant
(config may tighten platform safety but never widen it), and helpers including
`codingStandardContext()`. Built by PR #82 (8b009a9). Every symbol was
re-exported from the transformer barrel and called by nothing outside its own
test file (`docs/missions/CURRENT_STATE.md` already recorded this).

The hypothesis worth testing was that the live Mission Context Compiler
(`packages/pipeline/src/mission-context-compiler.ts`), which now assembles
inherited context for a real model call, would want `codingStandardContext()`.
Testing it:

- The compiler's input type (`MissionContextInput`) has no coding-standard or
  config field. Its sections are mission identity, task, hard policies, mission
  decisions, organization memory, user preferences, graph, history,
  verification, exceptions, and evidence refs.
- The only live producer of that input, `apps/worker/src/mission-context.ts`,
  builds every section from **durable database stores** (missions,
  verifications, trajectories, organization memory). It has no repo checkout at
  the seam, and it already marks the two closest slots — `userPreferences` and
  `hardPolicies` — as `store_not_available`, because no such tenant store exists
  on main.
- Nothing in the repo reads a `mendpoint.yaml` off disk. `agent-config.ts` was
  the only mention of the filename, in its own parser default.

Feeding `codingStandardContext()` into the compiler would therefore require
inventing an entire config-loading surface — repo-checkout access at the mission
seam, a mendpoint.yaml loader, and a tenant-config-defaults store — none of
which exists. That is building the missing surface, not connecting to a live
path.

## Decision

We will remove both subsystems.

- Delete the `packages/billing` workspace in full.
- Delete `packages/transformer/src/agent-config.ts` and its test, and drop the
  re-export block from `packages/transformer/src/index.ts`.
- Delete the dedicated docs that presented these as available infrastructure
  (`docs/BILLING_SETTLEMENT.md`, `docs/CONFIG_AS_CODE.md`) and correct the
  stale references in `docs/USAGE_ENFORCEMENT.md` and
  `docs/missions/CURRENT_STATE.md`.

No type defined by either subsystem is imported by live code, so no type needs
to be preserved. `agent-config.ts` only *consumed* shared types
(`PolicyConfig` from `@mendpoint/policy`, `Role`/`Permission` from
`@mendpoint/platform`, `Confidence` from `@mendpoint/shared`, and
`./review-tier.js`); all of those remain in their home modules, and
`review-tier.js` keeps its independent barrel export.

## Alternatives considered

- **Wire `@mendpoint/billing` to the live billing surface.** Rejected: the live
  surface does usage-ledger settlement over `@mendpoint/db`, not invoicing or
  payment collection. There is no metering-to-invoice path to attach to; wiring
  would mean building one and inventing its route/job — speculative consumers
  the decision rule forbids.
- **Wire `agent-config.ts` into the Mission Context Compiler.** Rejected: the
  compiler is fed entirely from durable DB stores with no repo checkout, and no
  config-loading surface (repo-file loader + tenant-defaults store) exists.
  Connecting it would require building that surface first.
- **Leave both as-is.** Rejected explicitly: an unreachable, well-tested module
  reads as available infrastructure and has repeatedly misled work in this repo.
- **Remove code but keep the docs.** Rejected: dedicated docs describing shipped
  behavior are the same trap in prose. They are recoverable from git.

## Security impact

None, and removal slightly reduces attack surface. The Stripe collector held the
only in-repo path that could talk to a live payment processor
(`STRIPE_SECRET_KEY`, `MENDPOINT_BILLING_ALLOW_LIVE`); it was never reachable,
and removing it deletes that dormant capability. No authentication,
authorization, or tenancy-isolation behavior changes, because no live path
invoked either subsystem. No new route is introduced (the constraint against
creating an unauthenticated route does not arise, since nothing is wired).

## Data and compatibility impact

None. Neither subsystem had a persistence contract in use: `@mendpoint/billing`
wrote nothing on main (its ledgers and registries were never instantiated by
live code), and `agent-config.ts` read no file. No schema, migration, public
API, or wire format changes. The `@mendpoint/db` usage-ledger and
`billing-economics` accounting contracts that back the *live* billing surface are
untouched. The three `billing_stripe_*` entries in
`packages/shared/src/error-guidance.ts` are left in place: they are inert
guidance strings, not a persistence or API contract, and removing them would
enlarge the diff for no functional gain.

## Migration plan

Single step, no phasing. Delete the code and docs, drop the barrel re-export,
correct the two surviving doc references. A clean `npm run typecheck` across all
workspaces is the evidence that nothing depended on the removed code.

## Rollback

Both subsystems are fully recoverable from git:

- `@mendpoint/billing` — `git checkout <this-PR-parent> -- packages/billing`
  (built by #64 / aadb835 and #96 / 16e8388).
- `mendpoint.yaml` config-as-code — `git checkout <this-PR-parent> --
  packages/transformer/src/agent-config.ts packages/transformer/src/agent-config.test.ts`
  (built by #82 / 8b009a9), then restore the barrel block.

Rollback is clean at any time because nothing consumed either subsystem, so no
data or downstream state was ever produced that a restore would conflict with.

## Evaluation plan

Rebuild is justified only when a *live* consumer actually exists:

- Rebuild `@mendpoint/billing` when a metering-to-invoice-to-collect path is on
  main — a surface that turns the usage ledger into invoices and a route or job
  that drives settlement — i.e. when there is code that would call
  `resolvePaymentCollector` on a real invoice.
- Rebuild the `mendpoint.yaml` contract when a config-loading surface exists: a
  mission path with access to the customer repo checkout that reads
  `mendpoint.yaml` off disk, plus a tenant-config-defaults store, plus a
  compiler seam (e.g. a coding-standards or user-preferences section) that would
  actually carry `codingStandardContext()` into a model call.

Success signal for this removal: `npm run typecheck` passes across all
workspaces and the transformer, billing, pipeline, and api test suites are green
after the deletion, confirming nothing reachable depended on the removed code.
