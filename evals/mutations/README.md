# Mutations (Phase 2 — scaffold)

A later task fills this in. The mutation engine will introduce controlled,
ground-truth-preserving defects into otherwise healthy repositories so the corpus
can expand into hundreds of cases without hand-authoring every repo.

Planned mutation families (from the spec):

- **API**: removed endpoint, renamed field, changed enum, response-type change,
  nullability change, pagination change, auth change, webhook-schema change,
  signature-validation change, SDK breaking change, rate-limit / timeout /
  idempotency semantics change.
- **Dependency**: incompatible upgrade, transitive conflict, deprecated-function
  removal, version mismatch, runtime-version change.
- **Architecture**: new hidden coupling, circular dependency, shared state,
  cross-layer access, schema drift, duplicated implementation, broken boundary.
- **Runtime**: race condition, retry storm, missing timeout, partial failure,
  malformed payload, unexpected null, cache inconsistency.
- **Security**: missing authorization, IDOR, unsafe deserialization, secret
  leakage, injection, incorrect trust boundary.
- **Legacy**: undocumented dependency, side effect in DB logic, brittle
  migration, business rule in a batch job, obsolete-but-live component,
  reflection-only "dead" code, environment-specific path.

## Contract

Each mutation must emit, alongside the mutated repo, the exact ground truth
required to score it (a `GroundTruth` object per `evals/ground-truth/schema.ts`),
including the `expected_findings`, `false_positive_traps`, and a counterfactual
(near-identical repo without the defect) for false-positive measurement
(Phase 14).

## Hard rules

- Never mutate a corpus repo in place — copy to scratch, mutate the copy.
- The generated ground truth is the source of truth; a mutation that cannot state
  its own answer key deterministically is not allowed.
