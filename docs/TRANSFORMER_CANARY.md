# Transformer end-to-end canary (Stage T4c)

The Transformer canary is a single, deterministic pass or fail proof that the
whole Transformer pipeline composes end-to-end, from published-catalog
resolution through a delivered draft pull request, for the recipe families. It
is the prove-then-enable gate for T5: T5 flips the production Transformer gate
only after this canary is green.

- Module: `packages/eval/src/transformer-canary.ts`
- Test: `packages/eval/src/transformer-canary.test.ts`
- Script: `npm run eval:transformer:canary`

## What it proves

For at least one recipe per family, starting from the published, signed catalog,
the canary chains the real pipeline seams and asserts each step:

1. **Catalog resolution.** The published, signed provider-recipe catalog
   (`signPublishedProviderRecipes` + `createPublishedProviderRecipeCatalog`)
   resolves the family query to the executable recipe, and the resolved
   reference binds to the recipe digest and id.
2. **Workspace execution and verification.** `executeRecipeInWorkspace` applies
   the recipe in a disposable workspace on the supported fixture, the analysis is
   `applicable`, and the recipe's own verification commands exit zero.
3. **Inverse restore.** `restoreRecipeExecutionInWorkspace` returns the
   workspace to the exact input digest.
4. **Sealed adaptive candidate.** A minimal divergent adaptive candidate is
   built from the deterministic output and sealed with `sealAdaptiveCandidate`
   as the exact content-addressed bytes a reviewer will approve.
5. **Human review.** The candidate is recorded review-pending
   (`recordAdaptiveCandidate`) and approved (`reviewAdaptiveCandidate`) with an
   explicit reviewer principal, rationale, and timestamp.
6. **Delivery through the mock SCM adapter.** The approved candidate is enqueued
   (`enqueueAdaptiveDelivery`) and drained through the worker delivery path
   (`processJobsOnce` -> `runTransformerAdaptiveDelivery`) using the MOCK SCM
   adapters (`MockGitHubDelivery`, and the T4a GitLab selector's mock adapter via
   `transformerAdaptiveGitLabDelivery`). The canary asserts the reviewable draft
   pull request is produced with the expected branch and title, and that the
   candidate is promoted and the delivery is recorded in the audit log.

## Families covered

One representative recipe per family, resolved through the published catalog:

| Family         | Representative recipe                     | SCM adapter |
| -------------- | ----------------------------------------- | ----------- |
| `sdk`          | aws-sdk-js v2 to v3                        | GitHub mock |
| `framework`    | react-dom 17 to 18                        | GitHub mock |
| `runtime`      | node runtime 20 to 22                     | GitHub mock |
| `internal_api` | acme internal user-api rename (getUser to fetchUser) | GitLab mock |

The `internal_api` family is delivered through the GitLab mock so the canary
exercises the T4a provider selector's GitLab draft-merge-request path as well as
the GitHub draft path.

## Safety invariants asserted

- **Production gate default denied.** `assessTransformerGate` with the default
  (no config) returns denied with reason `transformer_gate_config_missing`. The
  canary never weakens the gate; it runs only because it composes the pipeline
  primitives directly within its own harness.
- **Draft only, never merged.** Every delivery is a draft pull request and the
  delivery job completes without any merge.
- **Out-of-scope abstain.** Each recipe abstains on its out-of-scope fixture
  (`unsupported` analysis, no matched paths).
- **Inverse restore is exact.** Restore returns the workspace to the exact input
  digest for every family.
- **Exact sealed bytes.** The promoted candidate carries the exact sealed digest
  and seal SHA that were approved.
- **Minimal divergence.** The adaptive candidate diverges from the deterministic
  output by exactly one reviewed file.

## Evidence summary shape (consumed by T5)

`runTransformerCanary()` returns a structured `TransformerCanaryReport`:

```
{
  schemaVersion: 1,
  corpusVersion: "2026-08-11.v1",
  generatedAt: <ISO>,
  passed: boolean,                       // T5 go/no-go signal
  provenance: {
    deterministic: true,
    liveModel: false,
    network: "none",
    scm: "mock",
    families: 4
  },
  familiesCovered: { sdk, framework, runtime, internal_api },   // booleans
  families: [
    {
      family, passed, scmProvider,
      recipe: { id, digest, provider },
      candidate: { id, status, candidateDigest, divergedFromDigest, sealedSha256 },
      delivery: {                        // the delivered draft-PR ref
        provider, draftPr: true, number, url, branch, title,
        baseBranch, baseSha, commitSha, changedPaths
      },
      invariants: [ { id, description, passed, expected, observed } ]
    }
  ],
  safetyInvariants: [ { id, description, passed, expected, observed } ]
}
```

`passed` is the single machine-checkable go/no-go signal T5 consumes: it is true
only when every family and every safety invariant passes and all four families
are covered.

## How to run

```
npm run eval:transformer:canary          # prints the PASS summary, exits non-zero on failure
npm test -w @mendpoint/eval              # runs the canary test with the rest of the eval suite
```

The canary is deterministic and CI-safe: no live model, no external network, and
mock SCM adapters only. It does not change the default agent-eval behavior-matrix
counts, and it lands gated-off for production.

## What it does NOT prove

- It is **not** a live-model trial. The adaptive candidate divergence and its
  review verification evidence are constructed within the canary harness so the
  human-review delivery path runs deterministically. Live-model behavior is the
  separate live lane (`eval:agents:live`).
- It is **not** a real customer repository or a real SCM. Delivery goes through
  the mock GitHub and GitLab adapters, never the network.
- It does **not** enable production. `MENDPOINT_TRANSFORMER_GATE` stays denied by
  default and the customer-warden profile stays Transformer-off; the canary
  never flips them. T5 is the step that flips the gate, and only after this
  canary is green.
