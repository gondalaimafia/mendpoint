# Verification and attestations

Run approved repository and contract checks, retain exact evidence, and optionally sign a formal software attestation.

Status: Verification production; attestations gated
Availability: Repository verification in active flows; formal attestation API requires explicit enablement and signing authority
Last verified: 2026-08-14

## Start here

Define a repository verification profile, run it against the immutable candidate, and inspect the evidence before approval.

1. Select approved commands from repository policy.
2. Run baseline and post-edit verification in the bounded workspace.
3. Store stdout, stderr, status, artifact digests, and comparison evidence.
4. When enabled, issue and verify a DSSE-wrapped in-toto statement for the exact artifact scope.

## What it does

- Allowlisted npm, Node, Python, Go, Rust, Maven, Gradle, and RSpec verification profiles
- OpenAPI breaking gates and API design review
- Baseline versus post-edit comparison and scoped waivers
- Immutable evidence records and verification artifacts
- in-toto Statement v1 inside DSSE with Ed25519 thresholds, expiry, revocation, and exact scope verification

## When to use it

- A candidate must prove configured checks before delivery.
- A reviewer needs immutable evidence rather than a success label.
- A downstream system requires a signed software statement.

## How it works

1. Repository policy supplies the only commands eligible for execution.
2. The runner records exact inputs, outputs, status, timestamps, and digests.
3. Delivery gates consume authenticated evidence and fail on stale or mismatched scope.
4. The optional attestation service signs the exact deterministic statement bytes and verifies signatures before parsing payload content.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| Repository verification profile | Configuration | Approved commands, bounds, environment, and waiver authority. |
| Verification evidence | Artifact | Command, result, output digests, and source/candidate binding. |
| POST /advanced-ai/attestations | API | Issue an attestation when advanced AI applications are enabled. |
| GET /advanced-ai/attestations/:id | API | Retrieve and verify stored attestation evidence. |

## Evidence and verification

- Repository command verifier: `packages/repair/src/verify.test.ts`
- Contract gates: `packages/contract/src/contract.test.ts`
- DSSE and in-toto: `packages/contract/src/software-attestation.test.ts`

## Safety model

- Arbitrary shell syntax is rejected and production commands come from approved policy.
- Waivers are attributable, scoped, and expiring.
- Attestation keys are injected authority; private keys never enter the statement or evidence.
- Signature verification happens before JSON parsing and exact scope checks.

## Limitations

- Network isolation is supplied by deployment infrastructure, not the command parser alone.
- Security scan evidence can be caller-supplied unless a configured scanner produces it.
- Formal attestations are gated by MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED and signing configuration.

## See also

- [Draft delivery](./draft-delivery.md)
- [Security and governance](./security-governance.md)
- [Post-trained models](./post-trained-models.md)
