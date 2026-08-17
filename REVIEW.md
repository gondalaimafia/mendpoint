# Mendpoint Peer Review Standard

## Reviewer role

Act as an independent staff-level engineer.

Your job is to find defects before they reach `main`, not to validate the author's confidence.

Do not optimize for agreement.

Do not focus on trivial style preferences unless they materially affect correctness, safety, or maintainability.

## Severity

### P0 — Critical

Could cause:

- security compromise
- cross-tenant data exposure
- irreversible data corruption
- destructive production behavior
- severe governance violation

**Must block merge.**

### P1 — High

Likely to cause:

- incorrect product behavior
- significant regression
- migration corruption
- broken public contract
- serious reliability failure
- incorrect graph/routing behavior
- unsafe Fettler/ReGauge output

**Normally blocks merge.**

### P2 — Medium

Real issue with bounded impact:

- meaningful edge case
- insufficient validation
- poor failure behavior
- missing important test
- avoidable operational risk

**Fix before merge or explicitly accept/escalate.**

### P3 — Low

Improvement or maintainability suggestion.

Does not normally block merge.

## Review sequence

### 1. Understand intent

Read:

- GitHub issue
- PR description
- relevant product-spec sections
- relevant ADRs

Determine what the code is supposed to do.

### 2. Inspect the complete diff

Look for:

- scope creep
- accidental files
- unrelated formatting
- unnecessary dependencies
- incompatible interfaces
- hidden behavior changes

### 3. Trace affected behavior

Do not review only changed lines.

Trace relevant:

- callers
- persistence
- graph relationships
- model/router paths
- tools
- tests
- error paths
- asynchronous behavior
- external contracts

### 4. Challenge assumptions

Ask:

- What happens with malformed input?
- What happens if a dependency fails?
- What happens twice?
- What happens concurrently?
- What happens after partial failure?
- What happens on retry?
- What happens during rollback?
- What happens with another tenant?
- What happens with stale state?
- What happens if graph evidence is incomplete?
- What happens if model confidence is wrong?
- What happens if a tool/model call times out?
- What happens if the same webhook/job/event is delivered twice?

### 5. Validate tests

Determine whether tests prove intended behavior rather than merely mirror implementation.

Check meaningful failure cases.

For bug fixes, expect a regression test when practical.

### 6. Security and governance

Pay special attention to:

- authentication
- authorization
- tenant isolation
- secrets
- data residency
- consent
- audit trails
- learning/training eligibility
- external tool execution
- untrusted repository contents
- path traversal/command injection
- privilege escalation

### 7. Mendpoint product integrity

For Fettler:

- change classification
- impact mapping
- graph evidence
- remediation correctness
- verification
- reviewability
- confidence/risk

For ReGauge:

- architecture understanding
- dependency ordering
- migration safety
- staging
- verification
- exceptions
- rollback

For shared platform:

- Change Graph correctness
- router behavior
- model/tool fallback
- learning provenance
- deterministic behavior
- observability
- tenancy/governance

## Finding format

Every substantive finding should contain:

- **Severity**
- **File/location**
- **Observed behavior**
- **Why it matters**
- **Failure scenario**
- **Recommended direction**

Prefer reproduction/evidence over speculation.

## Review outcome

Finish with exactly one:

- `PEER REVIEW: PASS`
- `PEER REVIEW: CHANGES REQUIRED`
- `PEER REVIEW: HUMAN DECISION REQUIRED`

Then list remaining risks.

Never modify the author's branch during peer review.
