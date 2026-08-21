# ADR-0008: Organization Memory as a governed, inspectable store

- **Status:** Proposed
- **Date:** 2026-08-21
- **Author:** Claude Opus (opus-coder)
- **Supersedes:** none
- **Superseded by:** none

## Context

Mendpoint had nowhere to persist a tenant-authored convention or preference —
"prefer the internal auth client over direct OAuth calls", "squash-merge only",
"no em dashes in user copy". Four artifacts resembled such a store and none was
one: `packages/platform/src/memory.ts` is a per-request in-process scratchpad
with no tenant field; `learning_records` structurally requires five evidence
foreign keys that a bare preference cannot supply; the `policies` table is keyed
on `consumer_id` with no API writer and is seed-time only; and
`packages/transformer/src/agent-config.ts` is a repo-file contract that nothing
reads.

A preference store has different admission rules from the learning corpus. A
preference is admitted on **provenance and precedence**, not on a redaction and
verification evidence digest. It also carries a governance risk the learning
corpus does not: a silently learned preference that overrides an explicit
instruction, or that leaks across tenants, would be a serious defect.

## Decision

We add `organization_memory`, a durable tenant-scoped store, with four
deliberate choices.

1. **Structural (Tier 1) tenant binding.** The primary key `recordId` is `omv1:`
   plus the sha256 of the record's canonical body, and `tenantId` is inside that
   body. Two tenants stating the identical convention get different keys by
   construction; a cross-tenant collision is arithmetically impossible, not
   merely filtered. Reads re-hash and re-assert the tenant. This mirrors the
   Change Graph (`gl_software_versions_v1`) rather than the filter-bound `mission`
   table or the tenant-less `gl_nodes`/`gl_edges`.

2. **Append-only supersession chains.** Every lifecycle transition and every edit
   is a new immutable row keyed by a stable `memoryId`, with database triggers
   rejecting `UPDATE` and `DELETE`. State is the chain head, re-queried on every
   check, following the `learning_consents` revocation pattern so a disable takes
   effect with no redeploy and no cache. History can never be destroyed by an
   edit.

3. **One activation control with an explicit threshold.** A single observation
   can never become `ACTIVE`. `assessActivation` is the sole gate to `ACTIVE` and
   requires either an explicit human confirmation or at least
   `CORROBORATION_THRESHOLD` (2) distinct observations, counted structurally via a
   unique fingerprint index. It returns an honest three-state result — eligible
   with a named basis, or blocked with a distinct reason — so "could not
   determine" never collapses into "eligible" (the house fail-closed template is
   `fettler-delegation-evidence.ts`).

4. **A single precedence resolver.** `resolveOrganizationDecision` is the one
   place that ranks `hard policy > Mission decision > confirmed Org Memory > user
   preference > inferred candidate`. It refuses any layer from a different tenant,
   asserts a policy or mission layer wins whenever one is present, and names both
   the memory that governed a decision and any memory that was present but
   outranked. Memory can never silently override an explicit instruction or
   become hidden policy.

The schema lives entirely in the static `CREATE TABLE IF NOT EXISTS` DDL, so an
existing volume converges on next boot with no `ALTER`.

`trainingEligible` defaults to `false` and no training path is built here.

## Scope not taken

This change does not wire Organization Memory into the model prompt, the lesson
classifier, or a context compiler; those are separate steps reviewed on their
own. It does not touch consent or learning-event schemas. It does not put any
objective code fact in the store — those remain in the Change Graph.

## Consequences

- A preference can now be persisted, inspected with full provenance, disabled,
  and reasoned about against higher authorities, all tenant-scoped.
- The store is inert until a future change wires producers (observation writers)
  and consumers (context assembly) to it. That wiring is intentionally out of
  scope so the governance surface can be reviewed in isolation.
- The activation threshold is a constant (`2`). If corroboration proves too eager
  or too strict, it changes in one place.
