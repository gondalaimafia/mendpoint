# Organization Memory precedence

This document describes `resolveOrganizationDecision` in
`packages/pipeline/src/organization-memory-precedence.ts`. It reflects the code.

## The precedence chain

Strongest first:

```
hard policy > current Mission decision > confirmed Org Memory
  > user preference > inferred memory candidate
```

Inferred memory — and even confirmed Organization Memory — must **never**
override a hard policy, a Mission decision, or a tenant boundary. The chain puts
hard policy and Mission decision above every memory layer, so security,
architecture policy, compliance, and explicit task requirements always win when
present.

## A single resolution function

Precedence is resolved in exactly one place, `resolveOrganizationDecision`, so
the ordering is not re-derived by scattered checks at each consumer. This follows
the house pattern of a single evaluation point (`evaluateExecutor` in
`packages/platform/src/router.ts`). The function is pure and total: same input,
same result, no external reads.

```ts
resolveOrganizationDecision(input): {
  winner: PrecedenceLayerName | "none";
  reason: string;
  appliedMemory: OrganizationMemoryReference | null;
  overriddenMemory: { layer; memory }[];
  overrides: PrecedenceLayerName[];
}
```

## Two safety-critical invariants

### 1. Memory cannot override policy, mission, or a tenant boundary

- **Tenant boundary.** Every provided layer is checked against the decision
  tenant. A layer from a different tenant throws
  `organization_memory_precedence_tenant_mismatch`. This is what makes a
  cross-tenant inferred candidate impossible to inject, rather than merely
  unlikely.
- **Override immunity.** Whenever a hard policy or a Mission decision is present,
  one of them must win. If the resolved winner is ever anything else, the
  function throws `organization_memory_precedence_override_violation`. Ordering
  already guarantees this; the assertion is the tripwire that fails loudly if the
  ordering is ever weakened.

### 2. Memory must not become hidden policy

The result names the memory that actually governed the decision
(`appliedMemory`), and every memory that was present but outranked
(`overriddenMemory`). A consumer therefore always learns **which memory
influenced a decision** and, just as importantly, when a memory was **not**
applied because a higher authority displaced it. A memory can never silently
override an explicit instruction — the specific failure this design exists to
prevent.

## How a memory record maps to a layer

`organizationMemoryPrecedenceLayer(record)` maps a head record to its layer:

- `ACTIVE` -> `confirmed_org_memory`
- `OBSERVATION` \| `MEMORY_CANDIDATE` \| `VALIDATION` \| `CONFIRMED` ->
  `inferred_candidate`
- `REJECTED` \| `STALE` \| `DISABLED` \| `DELETED` -> `excluded`

Because a disabled (or rejected, deleted, stale) memory classifies as
`excluded`, a consumer never builds it into a precedence input, so it stops
influencing resolution the instant its head flips — with no redeploy and no
cache. `toOrganizationMemoryReference(record)` narrows a head record to the
reference shape the resolver consumes.

## Tests that guard these properties

In `packages/pipeline/src/organization-memory-precedence.test.ts`:

- `an inferred candidate cannot override a hard policy` and
  `... a Mission decision` — die if the ordering is weakened (the override
  tripwire fires).
- `an inferred candidate from a DIFFERENT tenant is impossible to inject` — dies
  if the tenant check is removed.
- `confirmed Org Memory wins ... and is named` — asserts `appliedMemory` records
  which memory influenced the decision.
- The override cases assert `overriddenMemory` surfaces the displaced memory
  rather than dropping it silently.
- `a disabled memory is excluded and stops influencing resolution immediately` —
  the classification control.
