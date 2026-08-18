# Muse 1.2 and DeepSeek V4 Flash verifier design

Status: proposed implementation design for issue 172.

## Product contract

Muse 1.2 does the reasoning and generation. DeepSeek V4 Flash judges bounded observable evidence. It does not author migrations, mutate repositories, approve candidates, deliver pull requests, or replace deterministic verification.

The verifier answers three questions:

1. Is one Muse attempt sufficient for this task?
2. Is another Muse attempt economically justified?
3. Which deterministic survivor has the highest estimated probability of satisfying the task?

It never answers whether a failed deterministic candidate is safe. That candidate is already ineligible.

## Upstream decision

The design was informed by `llm-verifier` 0.2.0 at `115de305f23ed89bc42e86e010853c40059f3f7d` and TurboAgent 0.1.3 at `eeb61be9cb618ea9c52262cebf15092e7c185146`.

Mendpoint reuses the fine grained A through T expected reward, repeated criterion scoring, progress scoring, and Probabilistic Pivot Tournament concepts. It does not install TurboAgent or route production traffic through it. It does not use the upstream persistent score cache. The Mendpoint implementation binds scores to complete content and removes duplicate comparison edges.

The upstream DeepSeek path uses thinking mode. Mendpoint supports that mode for pinned comparison experiments and a nonthinking mode for the default cost focused experiment. Neither is assumed superior before the benchmark.

## Trust hierarchy

From strongest to weakest:

1. exact artifact, snapshot, tenant, policy, consent, and residency bindings;
2. deterministic acceptance criteria and required check results;
3. human review and observed production outcomes;
4. independent verifier reward;
5. generator confidence.

Lower layers cannot override higher layers. DeepSeek scores are always soft.

## Components

`AgentVerifier` orchestrates one immutable verification request. It validates the evidence pack, applies deterministic filters, calls an injected backend only for survivors, performs selection or progress scoring, and returns a frozen result with exact cost and evidence metadata.

`DeepSeekVerifierBackend` uses the official OpenAI compatible Chat Completions endpoint. Its default model is `deepseek-v4-flash`. The fine grained mode requests `logprobs=true` and `top_logprobs=20`. The request explicitly selects thinking or nonthinking mode and records that choice.

`MuseSelfVerifierBackend` is a controlled experiment arm. It uses the same package contract but a separate injected transport and identity. It cannot be selected as ordinary generation from this layer.

`EvidenceAssembler` creates a bounded evidence pack from Fettler or ReGauge artifacts. It contains task and acceptance criteria, observable plan or patch, exact changed paths, graph and retrieval evidence, blast radius, deterministic checks, and provenance. It excludes hidden reasoning.

`DeterministicCandidateFilter` rejects candidates with failed required checks, unmet explicit criteria, unsafe scope, artifact mismatch, or contradictory hard evidence. Rejected candidates are never sent to a verifier.

`FineGrainedReward` converts returned A through T alternative probabilities into a value from zero to one. Because hosted DeepSeek returns only the top alternatives from its complete vocabulary, telemetry records the mass and count of recognized score tokens. Missing or insufficient score evidence is a typed failure, not an invented neutral score.

`PivotTournament` performs a seeded, position balanced ring and a deduplicated pivot phase. Every directed edge has a content addressed identity. The ranking and tie break are deterministic for the same request and seed.

`VerificationPolicy` chooses pass through, self verification, independent verification, Best of N plus independent verification, or human escalation from risk, prior failures, expected value, remaining budget, data policy, and rollout mode.

`VerifierTelemetry` records model and backend revision, evidence and criterion digests, candidate identities, deterministic eligibility, pair scores, selected candidate, disagreement, tokens, latency, estimated cost, rollout mode, and whether the signal changed behavior. It stores no secret or private reasoning.

## Evidence pack

Every pack is versioned and binds:

- tenant, mission, product, task, repository, and snapshot identities;
- risk, data classification, residency, external processing authority, and consent;
- explicit acceptance criteria;
- observable candidate plan, patch summary, changed paths, and artifact digests;
- graph, retrieval, owner, test, and verification evidence references;
- deterministic check outcomes and hard disqualification reasons;
- bounded source excerpts after redaction;
- the exact assembler version and pack digest.

Trusted instructions and criteria are serialized separately from repository supplied data. URLs in evidence remain inert text. The verifier has no tools and cannot fetch links.

## Criteria

General criteria cover requirement correctness, root cause correctness, evidence support, scope discipline, verification quality, and safety.

Fettler adds semantic migration correctness, blast radius correctness, affected call site coverage, and compatibility evidence.

ReGauge adds architecture correctness, staged migration safety, behavior preservation, rollback adequacy, and bounded change sequencing.

Criteria are independently scored. One aggregate number never hides a failed hard criterion.

## Progress states

Progress is an observable state label plus criterion scores:

- not started;
- evidence gathering;
- plausible plan;
- candidate produced;
- deterministic verification incomplete;
- deterministic survivor;
- blocked;
- complete.

The first rollout only records progress. It does not stop or redirect a running mission.

## Selection and completion

Best of N operates on plans first. Multiple plans are cheaper to compare and safer to discard than multiple repository mutations. Best of N patches is permitted only when the task policy and expected value justify the extra generation and deterministic verification cost.

Completion requires every hard check. A soft completion reward may explain uncertainty or request another attempt, but cannot produce a passed verification verdict.

## Policy and economics

Low risk defaults to pass through. Medium risk may request one independent completion score. High risk may request Best of N plans plus independent ranking. Critical risk, repeated failure, unsafe data policy, or unresolved hard evidence escalates to a human or peer review.

Expected value compares the estimated improvement probability and cost of another Muse candidate, DeepSeek verification, and human escalation. Every backend call records input, cached input, output, and reasoning tokens when the provider reports them. Price comes from versioned configuration with an effective date and currency.

## Rollout

- `off`: no verifier construction or network call.
- `offline`: fixture and retained benchmark evaluation only.
- `shadow`: score production shaped evidence but never change behavior.
- `advisory`: display a recommendation to an authorized reviewer.
- `selective`: alter selection only for exact approved tenants and capabilities after gates pass.
- `automated`: reserved for a later accepted ADR and production proof.

The global kill switch is `DEEPSEEK_VERIFIER_ENABLED=false`. Missing configuration, invalid policy, or unavailable transport has the same no action effect in shadow and a fail closed escalation effect in any later behavior changing mode.

## Learning boundary

Verifier rewards, disagreements, and calibration observations are soft telemetry. They do not enter the strict version 1 governed learning verification field. A preference pair becomes useful only after a deterministic or human outcome identifies the authoritative winner. Model scores alone never make an example eligible for training.

## Threat model

The primary threats are prompt injection in repository content, secret egress, cross tenant cache reuse, stale or wrong artifact scoring, silent provider fallback, malformed log probabilities, position bias, duplicate comparisons, repeated spend after response loss, and model reward overriding hard evidence.

Controls are separate prompt namespaces, redaction and exclusion, complete content addressed identities, tenant binding, exact model binding, bounded time and concurrency, deterministic edge schedules, immutable receipts, strict response validation, kill switch, and hard evidence precedence.

## Evaluation contract

The benchmark uses identical candidate pools and exact task revisions across Muse Pass at 1, Muse self selection, DeepSeek selection, and oracle selection. It reports quality, safety, calibration, independence, latency, tokens, cost, and incremental cost per accepted improvement. Fixture tests prove code paths. Only an explicitly enabled live evaluation can prove provider behavior. A missing API key is recorded as blocked or skipped, never passed.

Selective rollout is unsupported until the retained held out report demonstrates a positive quality and economic result without a severe safety regression.
