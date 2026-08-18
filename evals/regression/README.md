# Failure → eval (the regression pipeline)

This module turns a **validated failure** into a **permanent regression eval** with
as little manual work as is safe. It closes Phase 8 of the intelligence-ownership
program: every diagnosed defect becomes a durable guard, so a later change that
reintroduces it is caught by the suite instead of by a customer.

## The path

```
failure  →  redaction / governance  →  reproducible task  →  grader  →  new evaluation  →  regression suite
```

| Step | Where | What happens |
| --- | --- | --- |
| **failure** | `cases.ts` (`RegressionCase.provenance`) | A real, validated failure is recorded with its source, the commit it was validated against, and a one-line note. Auditable, not anecdotal. |
| **redaction / governance** | `governance.ts` (`assertAdmissible`) | The case may enter the committed suite only if its data provenance is certified (`synthetic`, or `redacted-from-customer` **with** a redaction reference) and it carries no customer data. Answer-key isolation is enforced here too: the reproducing repo may contain no grading-key file. A case that fails governance throws — loudly, at build time. |
| **reproducible task** | `cases.ts` (`RegressionCase.build`) | A deterministic builder materializes the reproducing repo **in memory** from the committed synthetic fixtures plus a hand-authored residual file that encodes the idiom. Never the shared corpus; never a hand-copied answer key. |
| **grader** | existing `evals/graders/*` | The machine-readable ground truth (`correct_behavior`, `expected_findings`, `recipe_expectation`, …) is scored by the SAME deterministic graders every other scenario uses. No new judge, no LLM. |
| **new evaluation** | `build.ts` (`regressionScenarios`) | Each governed case becomes a `GeneratedScenario` on the `regression` dataset split (spec §18.9). |
| **regression suite** | `generators/families.ts` | `regressionScenarios()` is folded into `generateAllScenarios()`, so the guards run on every `npm run eval:synthetic` and feed the readiness gates for their capability. |

Answer-key isolation is preserved end to end: generated repos never contain a
grading key (`governance.ts` asserts it), and every scenario is still staged
through `runners/stage.ts` before the product sees it, so an LLM-enabled product
could never read its own answer key off disk.

## The `status` field, and why the suite self-checks

Each case records what the **current shipped engine** does with it:

- **`fixed`** — the product now does the safe thing. The case is a guard: it
  passes today and fails the day the fix regresses. Every `fixed` case names the
  change that fixed it (`fixedBy`).
- **`open`** — the product is still wrong. The case fails **honestly** and flips
  green the day the fix lands. An open case is not a bug in the harness; it is the
  harness doing its job.

`regression.test.ts` runs the real analyze path for every case and asserts the
recorded `status` matches reality, so a stale catalog (a `fixed` case that
regressed, or an `open` case quietly fixed without updating the record) fails the
test suite. This is the "re-check, don't assume" discipline encoded as a test.

## What is in the catalog today

Sourced from the OSS validation (`C:/Users/Talal/dev/oss-kinked/VALIDATION-REPORT.md`,
which found 12 cases where the product was wrong and the eval was green) and the
readiness run. PR #174 closed the runtime-idiom and SDK/framework residual gaps;
these cases re-check that on every run.

| Case | Capability | Idiom (OSS ref) | Status |
| --- | --- | --- | --- |
| `reg-regauge-runtime-platform-residual` | runtime | `FROM --platform=… node:20` residual (K3) | fixed (#174) |
| `reg-regauge-runtime-digest-residual` | runtime | `FROM node:20@sha256:…` residual (K4) | fixed (#174) |
| `reg-regauge-runtime-nested-engine-residual` | runtime | nested `engines.node: ^20` residual (K5) | fixed (#174) |
| `reg-regauge-aws-vendored-residual` | sdk | vendored `require("aws-sdk")` residual (K7) | fixed (#174) |
| `reg-regauge-internal-api-acme-residual` | internal-api | un-renamed `getUser` consumer residual (case 6) | **open** |

The four `fixed` cases each report `applicable` (ship a partial migration) on the
pre-#174 engine and `incomplete` (refuse) now, so they are genuine guards for
that fix. The `open` case reports `applicable` today because internal-API residual
detection is not implemented (`isResidualSite` returns `false` for the
`internal_api_*` kinds in `packages/transformer/src/recipe.ts`); it fails P0 and
will pass the moment that gap is closed.

## Honest limitations

- The runners are **analyze-only** (`runners/regauge-runner.ts`,
  `runners/fettler-runner.ts` with `useLlm: false`). A regression eval here proves
  the engine's *decision* (refuse vs. apply), **not** that an applied migration
  compiles or that a subject repo still installs. "Would refuse" is not "did
  apply and verified." Closing that requires an apply-and-verify sandbox harness
  (Phase 2 blocker #5).
- The Fettler false-positive P0s (`gen-fettler-genvendor-both`,
  `gen-fettler-genvendor-vendored-only`) are already permanent development-split
  guards surfaced in `evals/FAILURES.md` and the readiness `open_p0` count. The
  pipeline here is product-agnostic (the schema and converter support Fettler),
  but those two P0s are deliberately **not** cloned into the regression split:
  doing so would double-count an already-permanent guard and perturb the Fettler
  micro-averaged precision/recall the readiness gate reads. They are referenced,
  not duplicated.
