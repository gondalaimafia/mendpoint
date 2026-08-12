# Transformer live model eval lane

This document describes the opt-in `live_model` evidence lane for Transformer:
a real Muse-tier model trial that drives the production adaptive planner over a
compiled synthetic fixture and records machine verified provenance. The lane is
gated so it runs only on explicit opt-in with real credentials. It never runs in
default `npm test` or CI, and it makes no network call unless every gate below is
satisfied.

The implementation is `packages/eval/src/transformer-live-eval.ts`
(`runTransformerLiveEval`). The command entrypoint is
`packages/eval/src/agent-eval-live.ts`, exposed as the `eval:agents:live` script.

## What it proves

Each trial runs the real adaptive planner adapter
(`resolveTransformerAdaptivePlannerAdapter`) through the Transformer router and
asks the live model to repair one deterministic recipe fixture: change only
`engines.node` in a synthetic `package.json` from Node 18 to `>=20 <21` while
preserving every other field exactly. The synthetic fixture is the only source
content sent by this lane. No workspace, repository, or customer data is read.

The grader verifies two independent things:

1. **Objective.** The returned plan edits exactly `package.json`, keeps the
   observed content digest, and produces a package that is byte-for-byte the
   held-out target. Any extra top level field, extra `engines` field, or altered
   script or dependency fails the objective closed.
2. **Provenance.** Every model call carries verified provider, configured and
   actual model id, deployment, execution region, and policy digest that match
   the production adapter policy exactly; a request id (body or header); https
   transport; nonzero and internally consistent token counts
   (`prompt + completion === total`); and a positive measured cost. The router
   ledger must also record the same provider, token count, and cost as the
   settled call.

The grader passes only when the objective and every provenance and accounting
grade pass. A failed objective or a fabricated or missing provenance field fails
the trial, and the lane never downgrades to another evidence lane.

## Honest provenance

Token counts and cost come from the actual provider response, not from a
placeholder. When the provider omits usage, the settlement is not treated as a
measured success: the trial is charged at its reservation ceiling, the
`accounting.settled` grade fails, and the trial fails. Cost is recorded as an
honest measured value or the reservation is charged; a genuinely unmeasured
field is never reported as a fabricated zero.

## How to run it (opt-in)

The lane is fenced behind two independent gates, plus a hard USD budget.

### Gate 1: eval opt-in

- `MENDPOINT_EVAL_LIVE_TRANSFORMER=1`
- `MENDPOINT_TRANSFORMER_LIVE_EVAL_TENANT=<tenant id>`

Without `MENDPOINT_EVAL_LIVE_TRANSFORMER=1` the runner throws
`transformer_live_eval_opt_in_required` before any provider call. Without the
tenant it throws `transformer_live_eval_configuration_required`.

### Gate 2: production adaptive planner policy for that tenant

These are the same production adapter variables Transformer uses in production.
The lane does not weaken or bypass them; it satisfies the real policy for the
eval tenant.

- `MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED=1`
- `MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_TENANTS=<tenant id>` (must include the eval tenant)
- `MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_PROVIDER=<provider id>`
- `MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_DEPLOYMENT=<deployment id>`
- `MENDPOINT_TRANSFORMER_ADAPTIVE_EXTERNAL_PROCESSING_APPROVED=1`
- `MENDPOINT_TRANSFORMER_ADAPTIVE_EXECUTION_REGION=<region>`
- `MENDPOINT_TRANSFORMER_ADAPTIVE_MAX_DATA_CLASSIFICATION=<classification>`
- `LLM_AGENT_MODEL=<approved model id>` (the model id the policy digest pins)
- `LLM_AGENT_URL=<https endpoint>` (or `OPENAI_BASE_URL`)
- `OPENAI_API_KEY=<key>` (or `XAI_API_KEY`)

The approved live model defaults to the Muse Spark contributor tier
(`muse-spark-1.2-contributor`); see `docs/MODEL_PROVIDERS.md`. The transmitted
model id is `LLM_AGENT_MODEL`, which the adapter pins into the policy digest, so
an unapproved model produces a policy digest mismatch and fails the provenance
grade.

### Budget

- `MENDPOINT_TRANSFORMER_LIVE_EVAL_MAX_USD` (default 25). A present but invalid
  value throws `transformer_live_eval_budget_invalid` before any call. A budget
  of 0 throws `transformer_live_eval_budget_exceeded`.

### Command

```
npm run eval:agents:live -- --product=transformer --repetitions=3
```

`--product` accepts `transformer`, `warden`, or `all`. The default is 3
repetitions. The runner enforces a minimum pass rate and consistency rate
(both default 1, override with `MENDPOINT_TRANSFORMER_LIVE_MIN_PASS_RATE` and
`MENDPOINT_TRANSFORMER_LIVE_MIN_CONSISTENCY`).

## Why the default run is byte identical

- The behavior matrix (`runWardenTransformerEval` in `agent-eval.ts`) keeps
  `byEvidenceLane.live_model` at `{ passed: 0, total: 0 }` for both products.
  This lane is a separate opt-in entrypoint, not part of the default matrix, so
  the default matrix counts are unchanged.
- `transformer-live-eval.test.ts` exercises the runner with an injected mock
  client (`fetchImpl`) and an injected price table. No test performs a real
  network call. The opt-out tests assert the runner refuses before any provider
  call.
- The production gate `MENDPOINT_TRANSFORMER_GATE` default stays denied and the
  customer-warden profile stays Transformer-off. This lane does not change any
  production default.

## Limitations

- The lane proves the live provider can produce and the grader can verify a
  correct, provenance-backed repair for one deterministic fixture. It is not a
  measure of general migration quality across arbitrary repositories.
- It exercises the adaptive planner path, not the full delivery path. Branch,
  pull request, review, and merge delivery are covered by other evidence and are
  not part of this lane.
- Consistency is measured across repetitions of the same fixture. It does not
  claim consistency across different tasks.
- A green default suite says nothing about the live lane. The live lane is only
  evaluated when the gates above are set and the command is run explicitly.
