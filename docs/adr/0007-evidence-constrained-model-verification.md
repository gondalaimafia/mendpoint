# ADR-0007: Evidence constrained model verification

- **Status:** Proposed
- **Date:** 2026-08-17
- **Author:** OpenAI Codex
- **Supersedes:** none
- **Superseded by:** none

## Context

Mendpoint already separates deterministic verification from model confidence, but it does not have an independent model verifier that can compare multiple plausible Muse candidates. Issue 172 introduces DeepSeek V4 Flash as a verifier and scorer while Muse 1.2 remains the primary reasoning and generation model. This affects the verification semantics in specification section 15, model routing in section 13, governed learning in section 17, and external data policy in section 19.

The upstream `llm-verifier` 0.2.0 implementation at commit `115de305f23ed89bc42e86e010853c40059f3f7d` is MIT licensed and provides useful fine grained reward, progress, and Probabilistic Pivot Tournament concepts. Direct production use is unsafe for Mendpoint. Its public score cache does not bind the problem, candidate bytes, model, or settings. Its pivot phase can count an edge already present in the ring. It has no bounded retry or timeout policy and no tenant cost authority. TurboAgent 0.1.3 at commit `eeb61be9cb618ea9c52262cebf15092e7c185146` is Apache 2.0 licensed, but its explicit verifier key path constructs a Google client and can silently return the first candidate when verification fails. A global proxy would also put verification in the ordinary generation path, contrary to the required model roles.

DeepSeek's official Chat Completions API supports `deepseek-v4-flash`, thinking and nonthinking modes, content log probabilities, and up to 20 alternatives. The hosted endpoint does not constrain the vocabulary to the A through T score tokens, so the resulting expected reward is a conditional estimate over whichever score tokens appear in the top alternatives. It is a soft signal, not proof.

## Decision

We will implement a provider neutral TypeScript `AgentVerifier` package in Mendpoint and adapt the upstream scoring and tournament concepts rather than deploy either upstream repository as a production proxy or runtime dependency.

The verifier will enforce this authority order:

1. exact tenant, snapshot, artifact, consent, residency, and external model eligibility;
2. deterministic acceptance criteria, required checks, scope, safety, and verification evidence;
3. human approval and authoritative outcome evidence;
4. model verifier reward and Muse confidence as soft signals only.

A model reward can rank only deterministic survivors. It cannot turn a failed check into a pass, widen mutation scope, authorize delivery, advance a mission, or satisfy a hard learning verdict.

The package will expose immutable, versioned contracts for evidence packs, criteria, candidates, backend scoring, selection, progress, policy, telemetry, and failures. DeepSeek will use a dedicated verifier transport and credential. It will not be added to the ordinary generation provider registry. Muse self verification will remain a comparison backend, not the default authority.

Mendpoint will correct the upstream hazards by using content addressed request and cache identities, deduplicating directed comparison edges, validating candidate and pivot counts, bounding concurrency and time, retaining exact model and request metadata, and recording tenant scoped tokens, latency, and estimated cost. Prompt inputs will use separate trusted instruction, criteria, evidence, and candidate sections. Repository content is untrusted data and never instructions.

Rollout will be versioned as `off`, `offline`, `shadow`, `advisory`, `selective`, or `automated`. The initial integration is default off and may run in shadow only. Shadow output cannot change candidate selection or execution. Progression requires retained held out evidence for quality, calibration, safety, independence, and incremental cost per accepted improvement.

Verifier telemetry will be a separate soft signal artifact. The strict governed learning event version 1 will not be widened or overloaded. A later join may reference verifier telemetry only after deterministic or human outcomes establish the authoritative label.

## Alternatives considered

**Deploy TurboAgent as the global model proxy.** Rejected. It changes every model request, has an unsafe explicit DeepSeek key path, can silently return the first candidate, logs broad request and response data, and does not preserve Mendpoint's generation and verification authority boundaries.

**Import the Python `llm-verifier` package directly.** Rejected for the production path. Mendpoint's workers are TypeScript and do not ship a Python runtime. The upstream cache, timeout, accounting, and duplicate edge behavior also violate Mendpoint's replay and tenant boundaries. A pinned Python comparison may be used only in reproducibility evaluation.

**Add DeepSeek to the existing generation provider registry.** Rejected. It would make the verifier routable as a doer and blur cost, policy, and credential authority.

**Use Muse self verification only.** Retained as a benchmark control but rejected as the only verifier because correlated model errors are the primary reason to test an independent model.

**Do nothing.** Rejected as the implementation path because Mendpoint lacks empirical evidence about when another Muse candidate or an independent verifier improves outcomes. The rollout remains off if the experiment shows no value.

## Security impact

This introduces a new external model egress boundary. Every request must pass tenant scoped data classification, residency, consent, and external processing policy. Source text must be bounded and redacted before transport. Ambiguous secret bearing content is excluded. The API key is supplied only through the injected transport configuration and is never serialized into evidence, telemetry, errors, cache keys, or logs.

Candidate text and repository evidence are untrusted. They cannot modify verifier criteria or system policy. Private chain of thought is forbidden from inputs and persisted outputs. Responses are bounded and schema validated. Missing scores, malformed tags, timeouts, rate limits, provider failures, kill switch activation, or uncertain results fail closed and never change the product action.

Tenant identifiers bind the complete request and telemetry record. Cross tenant candidates, evidence, or cache entries are rejected before a backend call. The content addressed cache includes tenant, task, candidate, criteria, model, prompt, and configuration digests and never stores credentials.

## Data and compatibility impact

The verifier contracts and telemetry are new versioned artifacts. Existing agent verifier state, router verification verdicts, and governed learning event version 1 remain unchanged. Existing callers see no behavior change when verifier configuration is absent or the rollout mode is `off`.

The default independent model ID is operational configuration, not a public storage key. Historical telemetry retains the exact model and backend revision used. No existing database schema or wire route is changed in the first shadow slice.

## Migration plan

1. Land the standalone package, tests, proposed design, and offline benchmark with no runtime caller.
2. Add default off evidence assemblers and shadow hooks for Fettler and ReGauge without changing product decisions.
3. Retain telemetry and compare Muse Pass at 1, Muse self selection, DeepSeek selection, and oracle selection on versioned held out tasks.
4. Calibrate scores and define capability specific quality, safety, cost, and latency thresholds.
5. Move to advisory or selective behavior only through a later reviewed configuration change with exact tenant and capability authority.
6. Keep automated behavior disabled until a later accepted ADR and production evidence explicitly authorize it.

All steps are backward compatible because absence of an enabled verifier preserves current behavior.

## Rollback

Set the global kill switch to false or the rollout mode to `off`. Runtime hooks stop calling the backend and ignore all soft scores. Existing telemetry can be retained for audit and does not affect deterministic verification, routing, missions, approvals, delivery, or learning eligibility. No data migration is required.

## Evaluation plan

The canonical experiment compares the same Muse candidate pools under four arms: Pass at 1, Muse self selected Best of N, DeepSeek selected Best of N, and oracle Best of N. It reports selection accuracy, oracle gap, misranking, false confidence, error correlation, calibration, tokens, latency, verifier cost, total generation cost, and incremental cost per accepted improvement for candidate counts supported by the cohort.

Tests cover deterministic failure precedence, content addressed identity, duplicate edge elimination, positional balance, score ties, malformed or missing log probabilities, timeouts, cancellation, prompt injection, secret exclusion, tenant isolation, consent and residency, kill switch, shadow no effect behavior, stable telemetry, and private reasoning rejection.

The decision is reconsidered if DeepSeek does not improve held out selection, has materially correlated errors with Muse, produces unsafe false confidence, or fails the economic threshold. In that case Mendpoint keeps the verifier off or uses a narrower policy rather than weakening deterministic gates.
