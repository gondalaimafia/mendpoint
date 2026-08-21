# Organization Memory lifecycle

This document describes the lifecycle implemented in
`packages/db/src/organization-memory.ts`. It reflects the code, not an aspiration.

## Statuses

```
OBSERVATION -> MEMORY_CANDIDATE -> VALIDATION -> CONFIRMED -> ACTIVE
```

plus the off-path terminal-ish states `REJECTED`, `STALE`, `DISABLED`,
`DELETED`. `OBSERVATION` is declared for completeness; a recorded observation
rests at `MEMORY_CANDIDATE`.

Only `ACTIVE` memory governs decisions as confirmed Organization Memory. Pending
states are treated as inferred candidates. `REJECTED`, `STALE`, `DISABLED`, and
`DELETED` do not participate in resolution at all.

## Transitions

| Function | From | To | Notes |
|---|---|---|---|
| `recordOrganizationMemoryObservation` | (none) | `MEMORY_CANDIDATE` | First observation. Inferred sources only. |
| `recordOrganizationMemoryObservation` | `MEMORY_CANDIDATE` | `MEMORY_CANDIDATE` or `VALIDATION` | Independent corroboration; advances to `VALIDATION` at threshold. |
| `createExplicitMemory` | (none) | `ACTIVE` | Human, explicit source. Routes through the activation control. |
| `confirmOrganizationMemory` | `MEMORY_CANDIDATE` \| `VALIDATION` | `CONFIRMED` | Human confirmation. |
| `activateOrganizationMemory` | `VALIDATION` \| `CONFIRMED` | `ACTIVE` | Gated by the activation control. |
| `rejectOrganizationMemory` | `MEMORY_CANDIDATE` \| `VALIDATION` | `REJECTED` | Human. |
| `editOrganizationMemory` | any non-terminal | same status | New revision, edited content. |
| `disableOrganizationMemory` | any non-terminal | `DISABLED` | Human. Stops influence immediately. |
| `deleteOrganizationMemory` | any non-terminal, or `DISABLED` | `DELETED` | Soft delete; history preserved. |
| `markOrganizationMemoryStale` | `CONFIRMED` \| `ACTIVE` | `STALE` | For example a long-unconfirmed memory. |

Every function appends a new immutable record superseding the current head. No
function updates or deletes an existing row; the append-only triggers enforce
that at the database level.

## The promotion threshold (central governance property)

**A single observation can never become active memory.** Promotion to `ACTIVE`
requires **either**:

- an explicit human confirmation (a `human_confirmed` or `created_explicit`
  transition on the chain), **or**
- repeated independent corroboration: at least `CORROBORATION_THRESHOLD`
  (currently `2`) **distinct** observations.

The threshold is explicit in code, in `assessActivation`, not implicit in a
query. `assessActivation` returns an honest three-state result:

```ts
type OrganizationMemoryActivationAssessment =
  | { status: "eligible"; basis: "human_confirmation" | "independent_corroboration" }
  | { status: "blocked"; reason:
      "memory_not_found" | "already_active" | "status_terminal" | "insufficient_corroboration" };
```

"Could not determine" never collapses into the reassuring value: a lone
observation returns `blocked / insufficient_corroboration`, not eligible. Both
`activateOrganizationMemory` and `createExplicitMemory` route through this single
control, so there is exactly one place where a memory can become `ACTIVE`.

### Independent corroboration is counted structurally

Each observation carries an `observationFingerprint`. The unique index
`(tenant_id, memory_id, observation_fingerprint)` means the same fingerprint can
be recorded at most once per memory. Re-submitting the same observation is
idempotent and cannot inflate the corroboration count. The distinct-observation
count is the number of records on the chain with a non-null fingerprint.

## History and edits

An edit is a new revision that carries the edited fields forward; prior revisions
remain byte-for-byte intact and readable through
`getOrganizationMemoryProvenance`. A disable or delete is likewise a new record.
Nothing in the API or store can destroy a prior revision — the append-only
triggers `RAISE(ABORT, 'organization_memory_append_only')` on any `UPDATE` or
`DELETE`.

## Tests that guard these properties

Each control has a test in `packages/db/src/organization-memory.test.ts` that
fails if the control is removed:

- `a single observation cannot reach ACTIVE` — dies if the corroboration guard in
  `assessActivation` is deleted.
- `two independent observations validate, then activate to ACTIVE` and
  `a human confirmation promotes a single-observation candidate` — the two
  promotion paths.
- `re-submitting the SAME observation cannot inflate corroboration` — the
  distinct-fingerprint control.
- `an edit preserves prior history rather than destroying it` and
  `append-only: raw UPDATE and DELETE are rejected` — the append-only triggers.
- `a disable flips the head immediately, with no redeploy` — the head re-query.
- `an existing volume that predates the table gains it on next boot` — schema
  convergence.
