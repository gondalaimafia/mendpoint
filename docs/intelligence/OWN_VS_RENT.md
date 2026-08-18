# Intelligence Ownership Matrix — Own vs Rent

Phase 1 of the Intelligence Ownership program. Analysis only; this document changes no code.

- Canonical spec: `docs/product/mendpoint-product-platform-specification.md` (v2.0, ADR-0001). `npm run spec:check` reports `PRODUCT CONTRACT PASS: 84 requirements, spec 2.0`.
- Worktree analysed: `origin/main` at `fcec22e`.
- Corpus of external evidence: `C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md` (35 kinked-clone cases against `1d3ae5a`).

## 0. How to read this document

Every claim about product behaviour carries a `file:line`. Every number is either **measured** (read out of a committed artifact or a committed threshold) or **not measured**. Nothing is estimated numerically. Where the program's template asks for a figure that does not exist, the cell says `not measured` and names the experiment that would produce it. Qualitative judgements (risk, latency sensitivity, repetition, breadth of reasoning needed) are labelled **estimated** and are inferences from the cited code, not observations.

Classification vocabulary:

| Value | Meaning |
| --- | --- |
| `OWN_NOW` | Model-mediated, measurable today, and enough governed data exists to begin training. |
| `OWN_LATER` | Model-mediated and structurally ownable, but blocked on measurement, data, or traffic. |
| `RENT` | Model-mediated and should stay on a general/frontier model for now. |
| `DETERMINISTIC` | Implemented without a model, and that is the right answer. |
| `RECIPE` | Implemented as a versioned deterministic transform selected by evidence (spec §14). |
| `UNKNOWN` | The code does not settle whether this is a model task, or the task's real behaviour is not observable. |

## 1. Headline

**The product barely rents any intelligence, so the "own vs rent" trade is not yet live.**

The entire shipped system contains **four live model call sites**, and every one of them is **off by default**:

| # | Call site | Task | Default state |
| --- | --- | --- | --- |
| 1 | `packages/code-impact/src/llm-confirm.ts:156-222` | Call-site classification | Off — `resolveLlmConfirmMode()` returns `off` unless `LLM_CONFIRM=1` (`llm-confirm.ts:44-49`) |
| 2 | `packages/agent/src/agent.ts:2579-2589` | Repair tool selection + edit generation | Off — `if (!task.useLlm && !task.planner) return { status: "unavailable" }` (`agent.ts:2589`); `useLlm` from `LLM_AGENT === "1"` (`apps/worker/src/cli.ts:2720`) |
| 3 | `apps/worker/src/transformer-adaptive-planner.ts:646-662` | ReGauge adaptive repair planning | Off — requires `MENDPOINT_REGAUGE_ADAPTIVE_MODEL_SOURCE_ENABLED=1` plus a tenant allowlist plus external-processing approval (`transformer-adaptive-planner.ts:345-367`) |
| 4 | `packages/repair/src/plan.ts:122-227` | Legacy repair planning | Off — returns `null` without `LLM_REPAIR_URL`/`OPENAI_BASE_URL` and a key (`plan.ts:127-130`); only consulted when the deterministic planner produced fewer than 2 actions (`packages/repair/src/session.ts:369`) |

Everything else in the program's candidate list — provider-change classification, schema interpretation, impact detection, dependency reasoning, migration planning, migration sequencing, architecture reconstruction, verification, context selection, confidence, routing — is deterministic rule tables, parsers, graph algorithms, or signed codemods. Three of those are deterministic **by contract, not by accident**: `packages/transformer/src/legacy-behavior-extraction.ts:71` types the policy field as the literal `allowModelInference: false`, and `:201` fails closed on anything else.

Two consequences follow, and they set the whole program's near-term shape:

1. **There is no meaningful rent bill to reduce.** The committed eval run makes zero model calls (`evals/runners/fettler-runner.ts:92` `useLlm: false`; `evals/reports/latest.md:5`), so all 43 run records carry `"tokens": null`, `"estimated_cost_usd": null`, `"model": null` (`evals/reports/latest-runs.json`). Cost savings cannot be the justification for owning intelligence here.
2. **The measurement the program leans on measures the wrong thing.** The only capability with a live gate — `fettler-impact-analysis` — is the deterministic pipeline. Its precision 96.4% / recall 79.3% (`evals/reports/latest.md:27-28`) say nothing about any model. **Zero model-mediated tasks have any quality measurement at all.**

Under the program's own rule — *if we cannot measure it, we are not ready to train for it* — **no task in this product is `OWN_NOW` today.** Section 8 says so plainly and gives the shortest path out.

## 2. Master matrix

Twenty tasks. Fifteen are the program's candidate list; five are additions found in code (marked ✚). Nothing on the program's list was dropped — all fifteen exist, though two (`tool selection`, `test generation`) exist in forms the program did not anticipate.

| # | Task | Product | Class | One-line justification |
| --- | --- | --- | --- | --- |
| T1 | Provider-change classification | Fettler | `DETERMINISTIC` | Three independent hand-written rule tables plus a graphql-js cross-check oracle; the change *is* the structured diff, so there is no judgement left for a model. |
| T2 | API schema interpretation (OpenAPI/GraphQL) | Fettler | `DETERMINISTIC` | A `$ref` resolver and the real `graphql` library; structured input, structured output, refuses remote refs. |
| T3 | ✚ Changelog / deprecation-prose interpretation | Fettler | `OWN_LATER` | Six regexes and a 50-word stop list stand in for open-ended provider prose — the one place a model plainly beats the incumbent, and the incumbent's silent-zero failures are unmeasured. |
| T4 | Impact detection (candidate discovery) | Fettler | `DETERMINISTIC` | Deliberately high-recall token/graph matching; the design contract is soundness first, filtering later. |
| T5 | Call-site classification | Fettler | `OWN_LATER` | The best-shaped distillation target in the product — a closed 5-field schema at temperature 0 — but off by default, unmeasured, and its offline stand-in poisons the provenance label. |
| T6 | Dependency reasoning | Fettler | `DETERMINISTIC` | Reverse-import BFS and call-graph reachability with explicit unresolved-import recording; a model would add unsoundness, not recall. |
| T7 | ✚ Generated / vendored detection and restraint | Fettler | `DETERMINISTIC` | Signal- and provenance-based, not path-based, with first-class abstention; the strongest-designed subsystem in the package. |
| T8 | Migration planning | ReGauge | `DETERMINISTIC` | A filter with an exactly-one rule that abstains on zero or many matches; the plan is authored by a human blueprint, not inferred. |
| T9 | Migration sequencing | ReGauge | `DETERMINISTIC` | Kahn-style topological wave partition with cycle detection; a solved algorithm. |
| T10 | Architecture reconstruction | ReGauge | `DETERMINISTIC` | Model inference is forbidden by the policy type and enforced at runtime; extraction runs only pinned digest-allowlisted collectors. |
| T11 | Recipe selection / classification | ReGauge | `RECIPE` | Exact-match resolution over an ed25519-signed catalog; ambiguity is an error, never a ranking. |
| T12 | ✚ Residual / completeness detection | ReGauge | `RECIPE` | Regex/JSON scan that fails closed on partial migration — and the single largest correctness hole in the product (12 of 35 false-greens). Fix deterministically; spec §17.4 forbids training around it. |
| T13 | Migration / adaptive repair edit generation | ReGauge | `OWN_LATER` | The only model call with durable per-call accounting, seven deterministic output gates, and a wired precedent loop — and it is still default-off with no live eval in CI. |
| T14 | Root-cause analysis | Shared | `DETERMINISTIC` | Seven regexes plus a 50-mode knowledge base; only ~26% of diagnosed modes have an auto-fix, so the gap is coverage, not reasoning. |
| T15 | Remediation generation (repair patch) | Shared | `RECIPE` + `RENT` | A 19-rule deterministic patch table is the primary path; the model is a fallback consulted only when the rules produce fewer than 2 actions. |
| T16 | Test generation | Shared | `DETERMINISTIC` | The product does not generate tests — test files are forced read-only. The shipped answer is a deterministic prohibition, so there is no model task here to own. |
| T17 | Verification reasoning | Shared | `DETERMINISTIC` | The verdict is a real process exit code in a sandboxed microVM; a model's `finish{ok:true}` is explicitly re-verified and not believed. |
| T18 | Tool selection | Shared | `RENT` | The model picks from 9 fixed tools when enabled, with a deterministic phase-FSM as the floor; too few decisions and no outcome attribution to train on. |
| T19 | Context selection | Shared | `DETERMINISTIC` | Assembly, budgets and redaction are all deterministic; the model only *requests* through tool calls and is granted by byte-budgeted code. |
| T20 | Confidence estimation | Shared | `UNKNOWN` | Deterministic three-valued lookup tables in analysis, an ungated model self-score in execution, and a full calibration harness with no production emitter — the code does not settle what confidence means. |
| T21 | ✚ Organization-constraint inference | ReGauge | `DETERMINISTIC` | CODEOWNERS parsing into a precedence table with default-deny; the answer is policy, not inference. |
| T22 | Model routing / execution-path selection | Shared | `DETERMINISTIC` | Exactly one executor is registered per pass, so there is no choice to learn from; the router is a policy gate, not a chooser. |

(Numbering runs to T22 because T3, T7, T12 and T21 are additions inserted in pipeline order.)

## 3. Dimensions — Part A: demand and current performance

`M` = measured (committed artifact or committed threshold). `E` = estimated from cited code. `NM` = not measured.

| # | Task | Frequency | Risk if wrong | Latency sensitivity | Current model cost | Current quality |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Provider-change classification | `NM` — no production counter | High `E` — a missed breaking flag suppresses the whole downstream mission | Low `E` — runs once per ingested change | $0 `M` — no model called | `NM` for classification itself; the differ's output feeds the measured impact number |
| T2 | Schema interpretation | `NM` | High `E` — a dropped `$ref` silently empties the diff | Low `E` | $0 `M` | `NM`; partial resolution is at least *declared* (`change-intel/index.ts:369-388`) |
| T3 | Changelog prose | `NM` — and critically, no counter for silent-zero returns | Medium `E` — a missed rename means the mission never starts | Low `E` | $0 `M` | `NM` — zero eval scenarios exercise `changelog-parse.ts` |
| T4 | Impact detection | `NM` | High `E` — recall failure is a missed breakage in prod | Medium `M` — p50 63 ms, p90 1773 ms, max 120032 ms (budget ceiling, n=33) | $0 `M` | **precision 96.4%, recall 79.3% `M`** on 27 synthetic `flag_files` scenarios; FP 3.6% (4/111) |
| T5 | Call-site classification | `NM` — `confirmationPath: "hybrid_llm"` is written but never aggregated | High `E` — this decision is the precision/recall boundary | High `E` — up to 12 serial calls at 30 s timeout each inside the analysis budget | `NM` — `callOpenAiCompatible` discards the usage block (`llm-confirm.ts:218-221`) | `NM` — the graded path runs `useLlm: false` |
| T6 | Dependency reasoning | `NM` | High `E` — a missing edge is a silent false negative | Medium `E` — BFS bounded at 3 hops | $0 `M` | Indirect `M` — carried inside T4's recall; deep-indirection scenario passes 100%/100% |
| T7 | Generated/vendored + restraint | `NM` | High `M` — both open P0s are exactly this failure (`vendor/provider-sdk/index.ts` flagged) | Low `E` | $0 `M` | 2 open P0 false positives `M`; the same class is false-green in the kinked corpus (case 5) |
| T8 | Migration planning | `NM` | High `E` — a wrong plan is a wrong campaign | Low `E` | $0 `M` | `NM` — no plan-quality grader exists |
| T9 | Migration sequencing | `NM` | Medium `E` — mis-ordering breaks mid-campaign | Low `E` | $0 `M` | `NM` |
| T10 | Architecture reconstruction | `NM` — default-disabled | High `E` — a wrong behaviour model licenses a wrong migration | Low `E` | $0 `M` | `NM` |
| T11 | Recipe selection | `NM` | Medium `E` — a wrong match applies the wrong codemod | Low `M` — p50 134 ms, max 189 ms (n=10) | $0 `M` | 10/10 scenarios correct `M`, but 6 of those 10 are coverage gaps that cannot fail |
| T12 | Residual detection | `NM` | **Critical `M`** — signs a green verified success for a repo that no longer installs | Low `E` | $0 `M` | **12 of 35 kinked cases product-wrong-and-eval-green `M`**; residual detection absent for 4 of 5 families at `1d3ae5a` |
| T13 | Adaptive repair edit generation | `NM` | High `E` — this writes the customer's code | High `E` — bounded to 8 model calls / 120 s per unit | `NM` in evals; runtime schema records reserved-vs-charged tokens and USD per call | `NM` — `regauge-runner.ts:183` stops at `analyzeRecipe`; apply is never exercised |
| T14 | Root-cause analysis | `NM` | Medium `E` — a wrong diagnosis wastes an attempt, it does not ship | Low `E` | $0 `M` | `NM`; 13 of 50 modes have an auto-fix `M` (`fixes.ts:10-24` vs `knowledge.ts:98-586`) |
| T15 | Remediation generation | `NM` | High `E` — produces the diff a human reviews | Medium `E` | `NM` — `plan.ts` records nothing; `agent.ts` records fully | 5/5 warden-bench fixtures on heuristics, no LLM `M` (`docs/WARDEN_BENCH_INTERNAL.md:57`) |
| T16 | Test generation | n/a — does not exist | n/a | n/a | $0 `M` | n/a |
| T17 | Verification reasoning | `NM` | Critical `E` — a fake green is the worst outcome the product can produce | High `E` — 300 s ceiling per command | $0 `M` | `NM` — "verification_honesty" is on the harness's own unmeasured list |
| T18 | Tool selection | `NM` | Medium `E` — a bad pick wastes a step, bounded at 48 | High `E` — one call per step, 15 s timeout | `NM` in evals; per-call provenance recorded at runtime | `NM` |
| T19 | Context selection | `NM` | High `E` — spec §18.7 names `CONTEXT_SELECTION_FAILURE` as its own class | Low `E` | $0 `M` | `NM` |
| T20 | Confidence estimation | `NM` | High `E` — miscalibration is what turns abstention into a false positive | Low `E` | $0 `M` | `NM` — the ECE/Brier harness has no production emitter |
| T21 | Org-constraint inference | `NM` | Medium `E` — default-deny bounds the damage | Low `E` | $0 `M` | `NM` |
| T22 | Model routing | `NM` | Low `E` — with one executor the decision is `execute` vs `human_handoff` | Low `E` | $0 `M` | `NM` — the router-value grader exists but nothing produces its input |

### Why "current model cost" is $0 almost everywhere, and what would change it

This is not a data gap; it is a fact about the deployment. `evals/reports/latest.md:153` records it honestly: *"the deterministic analysis path the runner exercises makes no model calls … token cost is genuinely zero rather than estimated."*

Per-task cost **is** derivable in a live deployment. The schema is real and well built:

- `routing_ledger` carries `task_kind`, `selected_executor_id`, `input_tokens`, `output_tokens`, `cost_usd`, `started_at`, `completed_at` (`packages/db/src/index.ts:1108-1137`).
- `agent_run_meters` aggregates per run from that ledger with an explicit `cost_measured` flag so an unmeasured cost is `null`, never a fabricated zero (`packages/db/src/agent-run-meter.ts:97-157`).
- `warden_model_reservations` keeps `reported_*` and `charged_*` tokens and USD separately per model call (`packages/db/src/warden-model-accounting.ts:12-45`).

**No cost number has ever been committed to this repository**, and the two paths that would generate them (`llm-confirm.ts`, `repair/plan.ts`) record nothing at all. To get a real per-task cost: run the synthetic suite with `useLlm: true` and project the existing `modelAccounting` receipt into the `RunRecord` fields that already exist and are always null.

## 4. Dimensions — Part B: ownability

| # | Task | Proprietary data | Ground truth available | Eval maturity | Repetition | Needs broad reasoning | Deterministic potential | Specialised-model advantage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Provider-change classification | Low — public specs | Yes, mechanical (the diff *is* the label) | Medium — 33 scenarios feed it indirectly; no direct classification grader | High | No | **Already fully deterministic** | None |
| T2 | Schema interpretation | Low | Yes | Low — no direct grader | High | No | **Already fully deterministic** | None |
| T3 | Changelog prose | Medium — provider changelogs are public, but the *mapping we accepted* is ours | None today; derivable by back-labelling from accepted migrations | **Zero** | High | Moderate — natural-language variance is the whole problem | Low — six regexes is already the ceiling of the approach | **High** — this is what language models are for |
| T4 | Impact detection | High — customer repo structure | Yes, hidden answer keys, isolation enforced (`evals/runners/stage.ts:44,114`) | **Highest in repo** — the only versioned gate, micro-averaged, 4-scenario holdout, deterministic graders | High | No | **Already deterministic and it is the right shape** | Low — the measured failures are parser gaps, not reasoning gaps |
| T5 | Call-site classification | **High** — the (slice, change, verdict) triple is genuinely ours | **Nearly** — the 27 `flag_files` scenarios already produce per-site TP/FP/FN; they are just never run against the model path | **Zero for the model path** | **Very high** — closed 5-field output, temperature 0, ≤2500-char slice | Low — one local judgement over a bounded slice | Partial — `staticConfirm` already handles the confident cases; the model only sees the residual medium/null band | **High** — narrow, repetitive, precision-objective |
| T6 | Dependency reasoning | High | Yes (import-chain truth in the answer keys) | Medium — folded into T4 | High | No | **Already deterministic** | Low |
| T7 | Generated/vendored + restraint | High | Yes — the corpus has explicit false-positive traps | Medium — 2 open P0s are live findings from it | High | No | **Already deterministic and correctly designed** | Low |
| T8 | Migration planning | High | No — no plan-quality grader; `evals/graders/DEFERRED.md:47-65` sketches one, unbuilt | **Zero** | Medium | Yes `E` — the long-horizon case is genuinely open-ended | Currently 100% deterministic + human blueprint | Unknown — cannot be assessed without a plan grader |
| T9 | Migration sequencing | Medium | Yes, mechanical | Low | High | No | **Already deterministic; it is a solved algorithm** | None |
| T10 | Architecture reconstruction | **Very high** | No | **Zero** | Medium | Yes `E` | Currently deterministic **by contract** | Cannot be pursued without amending `legacy-behavior-extraction.ts:71` — an architecture decision, not a training decision |
| T11 | Recipe selection | Medium | Yes | Medium — 10 scenarios, but 6 cannot fail | High | No | **Already a recipe** | None |
| T12 | Residual detection | High | **Mechanically derivable** — apply the recipe, run install/build; residual iff it breaks | **Structurally zero** — `regauge-runner.ts:183` stops at analyze; residual is graded `COVERAGE_GAP` and can never fail a run (`regauge-graders.ts:211-213`) | Very high | No | **High — and a deterministic fix is in flight (PR #174)** | Low for the core; possibly useful for the long tail of Dockerfile/manifest idioms |
| T13 | Adaptive repair edit generation | **Very high** — verified, human-approved diffs on real repos | Yes in principle — the verification gate *is* the label (`adaptive-loop.ts:957-972`) | **Zero in CI** — the live eval is double-gated and absent from `ci.yml` | Medium-high within a family | Moderate | Low — this is genuinely generative | **High** — a per-family adapter is exactly spec §17.8's framework adapter |
| T14 | Root-cause analysis | High | Partial — failure logs are labelled by mode, but the mode table is the labeller | Low | High | Moderate | Already deterministic; the gap is that 37 of 50 modes have no auto-fix | Medium — the gap is fix coverage, which is T15 |
| T15 | Remediation generation | **Very high** | Yes — verifier pass/fail is an objective label | Low — 5 synthetic fixtures, heuristics-only | Medium | Yes for the tail | Already 19 rules; extending the table is cheap for known patterns | Medium |
| T16 | Test generation | n/a | n/a | n/a | n/a | n/a | The prohibition is deliberate and load-bearing | n/a |
| T17 | Verification reasoning | High | Yes — exit codes | **Zero** — "verification honesty" is explicitly unmeasured | High | No | **Already deterministic and must stay so** | **None — and a model here would be actively dangerous** |
| T18 | Tool selection | High | Weak — attempt outcome attributes to the whole trajectory, not to one pick | **Zero** | High | Moderate | The heuristic FSM already floors it | Low until per-step attribution exists |
| T19 | Context selection | High | No | **Zero** | High | No | **Already deterministic** | Medium `E` — retrieval quality is a known lever, but spec §17.4 routes retrieval lessons to `RETRIEVAL`, not `MODEL_WEIGHT` |
| T20 | Confidence estimation | High | Yes — outcome vs predicted confidence is mechanical | Harness built (`packages/graph-learn/src/confidence-calibration.ts`), **no production emitter** | High | No | High — calibration is a statistical fit, not a model | **This is a calibration problem, not a training problem** |
| T21 | Org-constraint inference | High | Yes — CODEOWNERS is the truth | Low | High | No | **Already deterministic** | None |
| T22 | Model routing | High in principle | **None — there is no choice to label** | Grader exists (`router-value-proof.ts`), **no data producer anywhere in the monorepo** | n/a | No | Already deterministic | **Zero until more than one executor is eligible per pass** |

## 5. Evidence and reasoning, per task

Only the load-bearing citations are repeated here; Part A and Part B above carry the rest.

### T1 — Provider-change classification → `DETERMINISTIC`

Three independent classifiers, all rule tables. OpenAPI: `breaking` is hard-coded at each emission site (`packages/change-intel/src/index.ts:423-617`) and the whole-change risk is a three-way rule at `:278-293`. GraphQL: a hand-written four-value table (`packages/change-intel/src/graphql-schema.ts:496-628`) **cross-checked against graphql-js `findBreakingChanges`/`findDangerousChanges` and unioned** (`:605-607, :631`) — a genuine second deterministic authority. Unified taxonomy: 12 fixed kinds (`unified-change-evidence.ts:8-21`).

**Reasoning.** The input is already a structured diff and the output is a closed enum; there is no natural-language judgement for a model to add, and a second authority already cross-checks the hardest case. Keep deterministic. One defect worth a separate issue rather than a training program: `unified-change-evidence.ts:352` labels *any* modification to any non-endpoint fact as breaking, which contradicts the finer differ at `index.ts:423-617`.

### T2 — API schema interpretation → `DETERMINISTIC`

`packages/change-intel/src/spec-ref.ts` is a hand-written `$ref` resolver with `MAX_REF_DEPTH = 64` (`:44`) that **refuses** remote refs rather than fetching them (`:56-60`). GraphQL uses the real library (`graphql-schema.ts:1-32`) with DoS limits at `:123-128`.

**Reasoning.** Parsing a formal grammar is the canonical deterministic task. Two brittle spots are engineering bugs, not model opportunities: success-response selection is `"200" ?? "201" ?? "default"` only (`change-intel/index.ts:165-168`), so a `202`/`204`/`2XX` spec silently yields no response schema.

### T3 — Changelog / deprecation-prose interpretation → `OWN_LATER` ✚

`packages/catalog/src/changelog-parse.ts:2` states its own scope: *"Heuristic changelog / deprecation blurb parser (no LLM)"*. The entire capability is `RENAME_PATTERNS`, a six-entry regex table (`:31-72`), plus a 50-entry `STOP_WORDS` list (`:77-127`) and three date regexes (`:142-164`).

**Reasoning.** This is the one place in the product where the deterministic incumbent is plainly weaker than a model would be: any changelog phrasing outside those six shapes — tables, bullet lists, "`foo` is going away, migrate to `bar`", non-English — yields zero replacements, silently. It is high-repetition with a small structured output, which is the classic distillation shape. It is `OWN_LATER` and not `OWN_NOW` because there is **no ground-truth corpus, no eval scenario, and no counter for how often the parser silently returns zero** — we cannot currently tell whether this failure costs us anything.

### T4 — Impact detection → `DETERMINISTIC`

`packages/code-impact/src/candidates.ts:300-549` is a four-layer deterministic discovery (SDK graph, syntactic, config heuristics, import expansion). Its own header (`:1-9`) declares the contract: fast, high-recall, deterministic. `packages/call-graph/src/types.ts:5` states the architectural intent — *"Prefer soundness (no missing edges) over precision; LLM stage filters noise."*

**Reasoning.** This is the correct division of labour and it is measured: precision 96.4% / recall 79.3% (`evals/reports/latest.md:27-28`). Critically, **the measured failures are not reasoning failures.** Recall collapses to 0% pass on `go-service`, `java-service`, `node-cjs-service`, `python-service` and `typescript-service` (`latest.md:62-70`), and the missed files are systematically JSON fixtures (`evals/FAILURES.md` FAIL-004..010: `tests/fixtures/*.json`, `testdata/*.json`). Those are indexer and language-support gaps. Spec §17.4 is explicit: *"Mendpoint SHOULD NOT fine-tune models to compensate for deterministic engineering defects."* **Owning intelligence must not be the answer to the largest measured Fettler quality gap.**

### T5 — Call-site classification → `OWN_LATER` (strongest candidate)

The only model-mediated Fettler task. `confirmWithLlmBudget` (`llm-confirm.ts:282-298`) is consulted **only** for medium-or-null static results — high-confidence static short-circuits at `:292`. The call is `temperature: 0`, `max_tokens: 300` (`:202-203`), budgeted to 12 per run (`:31`, enforced `:230`), on a ≤2500-char slice (`:77`). The output schema is five fields with closed enums (`:57-64`), parsed and rejected on any deviation (`:95-107`). Egress is redacted fail-closed (`:236-240`).

**Reasoning.** Structurally this is the best owned-intelligence target in the product: narrow, repetitive, deterministic-verifiable against an answer key, precision-objective, and the training data — (code slice, structured change, correct verdict) — is genuinely proprietary. Three things block it, all fixable:

1. **No traffic.** Default `off` (`:44-49`), so no production examples accumulate.
2. **No measurement.** The graded runner sets `useLlm: false` (`fettler-runner.ts:92`), so the model path has never been scored against the corpus that already contains the right labels.
3. **A provenance poison.** `heuristicConfirm` (`:110-154`) is pure substring counting with an unmotivated `hits >= 2 ? "high" : "medium"` threshold — and it stamps its output `confirmationPath: "hybrid_llm"` (`:127, :144, :151`). Any dataset built by filtering on `confirmationPath` would silently mix substring counts with real model decisions.

### T6 — Dependency reasoning → `DETERMINISTIC`

Reverse-import graph and BFS (`packages/code-impact/src/provenance.ts:94-136`), multi-language extension in `lang-import-graph.ts`, reverse call-graph reachability bounded at 3 hops (`packages/code-impact/src/expand.ts:35, 93-99`). Unresolved first-party specifiers are recorded rather than dropped (`lang-import-graph.ts:31-45`).

**Reasoning.** Graph reachability has a correct answer that an algorithm computes and a model can only approximate. Note a built-but-unused hand-off: `packages/call-graph/src/demand.ts:48-90` enumerates low-confidence edges *"that downstream LLM confirmation should prioritize"* — and nothing in `code-impact` consumes it. That is the natural context-selection input for T5 when T5 is turned on.

### T7 — Generated / vendored detection and restraint → `DETERMINISTIC` ✚

Generated code is detected by signal, not path (`packages/code-impact/src/generated.ts:16-64`) — the test at `restraint.test.ts:83-88` pins that `src/generated/handwritten.js` is **not** generated. Vendored code is detected by package-boundary provenance, never by a `vendor/` path name (`vendored.ts:12-24, 150-206`). Ambiguous field changes are never guessed (`change-intel/index.ts:238-261`) and are surfaced as their own outcome (`code-impact/index.ts:315-329`).

**Reasoning.** Abstention is the product's core safety property and it is correctly deterministic. But it is also where the two open P0s live: both are `vendor/provider-sdk/index.ts` flagged as a distractor (`evals/FAILURES.md` FAIL-001/002), and the kinked corpus reproduces the same class (case 5, vendored scoping). This is a deterministic bug to fix, not intelligence to own.

### T8 — Migration planning → `DETERMINISTIC`

`planTransformerMission` (`packages/transformer/src/mission-planner.ts:78-205`) selects recipes by filter; zero matches → `repository_recipe_not_applicable`, more than one → `repository_recipe_ambiguous` (`:138-149`). The module comment at `:73-77` states the rule: *"Ambiguous or unsupported scope is an abstention, never a guess."* `blueprint-planner.ts:336-673` is validation, normalisation and hashing, with `review.state = "awaiting_human_review"` at `:649`.

**Reasoning.** The long-horizon plan is authored by a human and validated by code. There is no model in this path at all — see §7, where this directly contradicts the program's hypothesis.

### T9 — Migration sequencing → `DETERMINISTIC`

Kahn-style topological wave partition with duplicate, self-dependency, missing-dependency and cycle detection (`blueprint-planner.ts:287-322`), with a second independent sequencer for delivery batching (`staged-pr-batches.ts:224-255`).

### T10 — Architecture reconstruction → `DETERMINISTIC` (by contract)

`packages/transformer/src/legacy-behavior-extraction.ts:71` types the field as the literal `allowModelInference: false`; `:201` fails closed with `legacy_behavior_model_inference_forbidden`. Extraction runs only pinned digest-allowlisted collectors (`:255-258`). `bsg-extractor.ts:19` documents that a spec is *"copied from a deterministic collector, never generated prose."*

**Reasoning.** Making this model-mediated is an architecture decision requiring an ADR (protocol §6 lists Change Graph construction and ReGauge planning as ADR-triggering areas). It is out of scope for an intelligence-ownership program to reverse by implementation.

### T11 — Recipe selection → `RECIPE`

`classifyRecipeContract` (`recipe.ts:3256-3284`) is a pure lookup over bound transform kinds across five families (`MigrationLabelFamily`, `:3224-3229`), and is documented as metadata that *"never gates or changes any control-flow decision"* (`:3231-3236`). Catalog resolution is ed25519-signature-verified exact match; zero → `recipe_not_found`, more than one → `recipe_ambiguous` (`recipe-catalog.ts:558-576`). Eight registered contracts across six families are enumerated at `recipe.ts:438, 757, 1071, 1131, 1398, 2770, 2905, 3020`.

**Reasoning.** Spec §14.3 requires applicability to be established by evidence, not text resemblance, and the implementation honours that. "Recipe exists" is settled. "Recipe is trustworthy" is T12.

### T12 — Residual / completeness detection → `RECIPE` (deterministic fix required, not training) ✚

`isResidualSite` (`recipe.ts:3542-3571`) scans the snapshot outside `allowedPaths`; a residual makes the analysis `incomplete` (`:3621-3622`) and `applyRecipeWithAnalysis:3808-3813` refuses to emit success. That is the correct design. At `1d3ae5a` the implementation covered only three runtime precondition kinds and returned `false` for everything else, so **aws-sdk, stripe, googleapis and react-dom had no residual detection at all** — PR #174's own description states this and demonstrates it against the real `executeRecipeInWorkspace`.

The independent validation confirms the consequence: **35 cases, 12 where the product is wrong and the eval is green** (`VALIDATION-REPORT.md:193`), with the residual class accounting for cases 1-4 and 6-12. The report's verdict: *"No family is safe for unattended self-serve on `main` today"* (`:250`).

**Reasoning.** The gap is a deterministic detector that was too narrow, and PR #174 is the right fix. Spec §17.4 puts a bright line here: *"Mendpoint SHOULD NOT fine-tune models to compensate for deterministic engineering defects."* Do not put this on the training roadmap. The only defensible model role is the long tail of Dockerfile and manifest idioms after the deterministic core lands — and even then only if the idiom variance turns out to be genuinely open-ended.

### T13 — Adaptive repair edit generation → `OWN_LATER`

The live call is `apps/worker/src/transformer-adaptive-planner.ts:646-662`. It is the most rigorously governed model call in the product:

- Strict JSON schema with `strict: true` (`:243-250`), then **re-validated locally without trusting strict mode**: envelope at `:499-565` (echoed model must equal policy model, usage arithmetic must reconcile, exactly one choice, `finish_reason` must be `stop`), plan at `:427-497` (key allowlist, mutation-path allowlist, digest regex, byte caps, enum membership).
- Then the loop re-checks the path allowlist and enforces a read-before-write content fence (`adaptive-loop.ts:557-583`).
- Then the objective verification gate is re-run and convergence requires `result.passed` (`:957-972`).
- Then a digest-verified seal, a deterministic review tier, and mandatory human approval.
- Durable reserve/settle accounting per call (`transformer-adaptive-planner.ts:618-631, 714-725, 755-767`).
- A precedent/learning loop is already wired: `enrichPlannerInputWithPrecedent` (`:188-203`), gated on `MENDPOINT_REGAUGE_LEARNING_ENABLED`.

**Reasoning.** This is where owned intelligence would pay the most: the training signal is objective (the verifier gate), the data is genuinely proprietary, the output is validated seven ways, and spec §17.8's framework/runtime adapter is exactly this shape. It is not `OWN_NOW` because the capability is default-off behind three separate flags, the eval that would score it is analyze-only (`regauge-runner.ts:183`), and the live eval is absent from `ci.yml`.

### T14 — Root-cause analysis → `DETERMINISTIC`

Seven regex rules in `packages/repair/src/diagnose.ts:6-56`; `classifyFailures` is regex filtering over a 50-mode, 12-category knowledge base (`packages/agent/src/knowledge.ts:98-586, 589-603`).

**Reasoning.** Only 13 of those 50 modes appear in `AUTOMATIC_REPAIR_MODES` (`packages/agent/src/fixes.ts:10-24`) — roughly a quarter of the diagnosed taxonomy has a fix. The bottleneck is fix coverage (T15), not diagnostic reasoning, and extending a rule table is cheaper than training.

### T15 — Remediation generation → `RECIPE` + `RENT`

`proposeWardenFix` (`packages/agent/src/fixes.ts:54-457`) is a 19-rule deterministic patch cascade returning at most one proposal. The model is a fallback: `packages/repair/src/session.ts:369` consults it only when `plan.actions.length < 2`.

**Reasoning.** Right structure — deterministic first, model for the tail. Keep renting the tail until T13's measurement exists, because the two share a training signal. One concrete defect: `packages/repair/src/plan.ts:122-227` is the **only** model call in the product with no token, cost, latency or provenance recording, and its output validation is a loose `text.match(/\{[\s\S]*\}/)` at `:210`.

### T16 — Test generation → does not exist, deliberately

`verifierProtectionPatterns()` (`packages/agent/src/agent.ts:1766-1793`) forces every test path read-only, injected into `ctx.readOnlyPaths` at `:3683-3686`, restated in the system prompt at `:2721`, and reinforced in the attempt engine (`attempt-engine.ts:1017-1020`) and the repair session (`packages/repair/src/session.ts:203-213`). A verifier that mutates the candidate is a hard stop (`agent.ts:4049-4060`).

**Reasoning.** The prohibition is what makes verification trustworthy. There is no model-mediated task here, and creating one would attack the product's central safety property. Listed because the program's candidate list names it and the honest answer is "we deliberately do not do this".

### T17 — Verification reasoning → `DETERMINISTIC`, and must stay so

The verdict is a process exit code (`agent.ts:4128-4133`). A model's claim of success is explicitly not believed — `agent.ts:4138-4142` re-runs the verifier when the planner calls `finish{ok:true}`. Execution is in a Fly microVM with host env deliberately not forwarded, and the header at `packages/repair/src/verify-sandbox.ts:12-16` records why: *"NEVER silently falls back to host execution — that silent fallback already produced a fake-green once (#99)."*

**Reasoning.** This is the one row where the recommendation is not "later, once measured" but "never". A model judging verification would reintroduce exactly the fake-green class the sandbox was built to eliminate — and which the kinked corpus shows the product still produces by other means (T12).

### T18 — Tool selection → `RENT`

The model picks from nine fixed tools under a strict schema (`agent.ts:140-148, 155-218, 2746-2753`); `nextHeuristicCall` (`packages/agent/src/heuristics.ts:32-180`) is a deterministic phase FSM used as the floor whenever the model fails (`agent.ts:3988`).

**Reasoning.** Nine options and a bounded trajectory is too small a decision space to justify a trained model, and — more decisively — attempt outcomes attribute to the whole trajectory, not to any individual pick, so there is no per-decision label to train on. Rent.

### T19 — Context selection → `DETERMINISTIC`

`plannerInput` (`agent.ts:2432-2493`) assembles ≤40 file digests, the last 10 steps at 500 chars each, and truncated goal/error text, all byte-budgeted by `sourceContextBudget` (`:2292-2350`). Whether raw source is included at all is a tenant policy gate (`modelSourceAuthorized`, `:2418-2430`). For Fettler, slice construction is span-based with a 40-line default (`code-impact/src/expand.ts:36, 51-73`) and the prompt payload is hard-capped (`llm-confirm.ts:75-77`).

**Reasoning.** Deterministic selection with fail-closed redaction is correct. Spec §17.4 routes retrieval lessons to the `RETRIEVAL` destination, not `MODEL_WEIGHT`, so improving context selection is a retrieval-engineering task, not a training task.

### T20 — Confidence estimation → `UNKNOWN`

Three different things are called confidence:

1. **Analysis:** deterministic three-valued lookup tables (`code-impact/src/candidates.ts:21-27, 322-329, 448-450`; `confirm.ts:73-82`).
2. **Execution:** a model self-score, schema-required in `[0,1]` (`agent.ts:212`), validated at `:323-324` — and **compared against no threshold anywhere**. `mutationIntentRejection` (`:1697-1744`) never reads it. It is aggregated for the human review artifact only (`attempt-engine.ts:830`). The heuristic path honestly reports `confidence: 0` (`agent.ts:1677`).
3. **Calibration:** a complete ECE / Brier / selective-accuracy harness with leakage guards (`packages/graph-learn/src/confidence-calibration.ts`), whose only callers are its own tests.

Spec §12.2 requires the opposite of (2): *"Confidence SHOULD be calibrated by task family and model/tool history rather than treated as an arbitrary language-model self-score."*

**Reasoning.** `UNKNOWN` because the code does not settle what confidence means or what it is for. Once settled, this is almost certainly a **calibration** problem — a statistical fit over recorded outcomes — not a training problem. The harness already exists; it needs an emitter.

### T21 — Organization-constraint inference → `DETERMINISTIC` ✚

A fixed precedence table (`packages/transformer/src/organization-constraints.ts:5-13`) with **default-deny** (`:219`) and equal-precedence contradiction as a hard error (`:184-193`). The repo-evidence side is CODEOWNERS parsing (`apps/api/src/transformer-mission-authority.ts:156-183`).

### T22 — Model routing → `DETERMINISTIC`, no choice exists

Verified directly. `buildWardenExecutorRegistry` (`apps/worker/src/warden-router.ts:154-161`) performs exactly one `registry.register(...)`, and `wardenExecutorDescriptor` (`:164-246`) returns **one of two shapes** on a config branch — `frontier_model` when a model source policy is configured (`:176`), else `deterministic_recipe` (`:212`) — never both. The router's own comment concedes it at `:58-69`: *"The Warden attempt is the single real executor today."* `routeTask` then takes `routes[0]` with an empty fallback chain (`packages/platform/src/router.ts:545-546`).

The one two-executor registry, `buildRoutedExecutorRegistry` (`apps/worker/src/transformer-router.ts:134-143`), is dispatch by required capability — its own comment at `:128-132` says the other executor *"is eliminated by capability"*. That is deterministic elimination, not a learnable choice.

**Reasoning.** Spec §13.4 defines a rich router objective and §17.12 wants routing outcomes to be learning data, but there is nothing to learn from: with one eligible path the only real decision is `execute` vs `human_handoff`. Consistent with this, `packages/eval/src/router-value-proof.ts` is a pure arithmetic validator over caller-supplied `baseline`/`candidate` observations (`:3, :100-102, :120-126`) — precisely specified, unit-tested, and **fed by nothing anywhere in the monorepo**.

## 6. Eval maturity is the binding constraint — the specifics

The program's premise holds and is if anything understated.

**Exactly one capability is gated.** `evals/readiness-gates.json` defines `fettler-impact-analysis` and nothing else: `impact_precision_min: 0.9`, `impact_recall_min: 0.85`, `max_open_p0: 0`, `holdout_dev_gap_max_pp: 10`. `evals/readiness.ts:241-248` only dispatches on that literal name; any other capability *"is intentionally not scored rather than scored with a placeholder that could read as a pass."*

**That one gate currently FAILS.** `evals/reports/latest.md:21-30`: overall readiness **FAIL** — precision 96.4% PASS, **recall 79.3% vs ≥85% FAIL**, **open_p0 = 2 vs ≤0 FAIL**, holdout within dev PASS.

**And it measures a path with the model switched off.** `evals/reports/latest.md:5`: *"deterministic analysis core (Fettler: change-intel → code-impact, LLM off; ReGauge: analyzeRecipe over shipped registry, analyze-only)."*

**The ReGauge runner is analyze-only, confirmed.** The sole product invocation in `evals/runners/regauge-runner.ts` is `analyzeRecipe(...)` at `:183`; the header at `:5-12` says *"We stop at analyze (do not apply)."* Consequently "the repo no longer installs after apply" is structurally unrepresentable — which is exactly the failure the kinked corpus found twelve times.

**Residual findings can never turn a run red.** `evals/graders/regauge-graders.ts:211-213` computes `passed` as "every failure is `COVERAGE_GAP` or `HARNESS_LIMITATION`", and a surfaced residual is filed as `COVERAGE_GAP` (`:87-97`).

**The gate does not gate CI.** `evals/runners/run-all.ts:269-277` exits 1 only under `--enforce-readiness`, and `package.json:42` (`eval:synthetic`) passes no such flag. The suite therefore exits 0 with `OVERALL FAIL` and two open P0s.

**The committed numbers are stale.** `evals/reports/latest.md:4` declares commit `ae8e17f`; HEAD is `fcec22e`, 32 commits later.

**The second eval surface adds little quantitative evidence.** `packages/eval/` is 42 files of mostly contract-grade graders. Only `eval:agents` runs in CI (`.github/workflows/ci.yml:27`), and it prints `Live model evidence 0/0` because no scenario in the CI set declares `evidenceLane: "live_model"` (`packages/eval/src/agent-eval.ts:84-87`). The two evals that do call a real model — `agent-eval-live.ts:581-590` and `transformer-live-eval.ts:451-457` — both refuse without explicit opt-in and neither is in `ci.yml`. No report artifact from `packages/eval` is committed.

**The corpus is entirely synthetic.** All 43 scenarios (21 hand-authored corpus repos + 22 generated) are synthetic; the answer keys live outside the git repo and are stripped at staging (`evals/runners/stage.ts:44, 114`). Answer-key isolation is genuinely enforced and holdouts are genuinely never inspected — the harness is honest. Its blind spot is what it cannot see, and the kinked corpus is the first look at real repository shapes.

To the harness's credit, it publishes its own limits (`evals/reports/latest.md:176-185`): `token_cost / model_routing (LLM off)`, `migration_patch_correctness`, `verification_honesty`, `pr_delivery`, `recipe_apply + verification_gate (analyze-only)`, `idempotency`, `inverse/rollback`.

## 7. Testing the program's hypothesis

> *Fettler holds the earliest owned-intelligence opportunities — repetitive, provider-specific, measurable, high volume — while ReGauge's long-horizon planning keeps benefiting from a frontier model.*

**Verdict: the second half is flatly contradicted by the code, and three of the first half's four premises fail. Only "repetitive" survives — but it points at a different task than the hypothesis implies.**

**"Measurable" — false as applied.** The measured Fettler capability is deterministic. `evals/runners/fettler-runner.ts:92` sets `useLlm: false`; `evals/reports/latest.md:5` and `:153` confirm no model is called and cost is *"genuinely zero rather than estimated."* The 96.4/79.3 figures measure a parser-and-graph pipeline. There is **no measurement of any model-mediated Fettler task whatsoever** — the one that exists (T5) has never been run against the corpus.

**"High volume" — not measured, and possibly near zero.** T5 is off by default (`llm-confirm.ts:44-49`). Nothing counts how often the confirm path runs, agrees with, or overturns the static verdict: `confirmationPath: "hybrid_llm"` is written (`:264, :271`) and read only by a Zod enum and two test fixtures. Volume is an assumption.

**"Provider-specific" — the architecture deliberately went the other way.** `evals/reports/readiness-scorecard.md:19` records the supported-provider row as *"provider-agnostic (driven by the OpenAPI diff, not a provider allowlist)."* The provider literals that remain — `/fetch|axios|http|acme|stripe/i` in the confidence-promotion path (`code-impact/src/candidates.ts:401`) and hardcoded `charges.*` tokens (`change-intel/index.ts:734-738`) — are treated as defects elsewhere in the same codebase. Spec §17.8's vendor-adapter strategy has nothing provider-specific to specialise on today.

**"Repetitive" — true, and it is the half worth keeping.** T5's output space is five fields with closed enums at temperature 0 over a ≤2500-char slice. That is a real distillation target.

**The hypothesis also points at the wrong Fettler problem.** Fettler's largest measured quality gap is recall, and it fails by language: 0% pass on go, java, python and node-cjs, with JSON fixture files systematically missed (`evals/reports/latest.md:62-70`; `evals/FAILURES.md` FAIL-004..010). Those are indexer and parser defects. Spec §17.4 forbids fine-tuning to compensate for deterministic engineering defects, so **owned intelligence is explicitly not the remedy for the thing Fettler is actually failing at.**

**The second half is wrong on the facts.** ReGauge's long-horizon planning is not model-mediated at all:

- Planning is a filter with an exactly-one rule that abstains on zero or many matches (`mission-planner.ts:138-149`).
- Sequencing is a topological sort (`blueprint-planner.ts:287-322`).
- Architecture reconstruction **forbids model inference by contract** (`legacy-behavior-extraction.ts:71, 201`).

The long-horizon plan comes from a human blueprint author, validated by hashes and approval bindings. The frontier model in ReGauge does the *opposite* of long-horizon reasoning: bounded, single-file, digest-fenced edits inside one verification loop, capped at 4 iterations per unit, 8 model calls and 32 KiB of context (`adaptive-loop.ts:47-56`).

**Corrected picture.** The model-mediated surface is tiny and sits at the **short-horizon, per-site** end of *both* products — call-site classification in Fettler, per-file repair in ReGauge. The long-horizon reasoning the hypothesis assumed we were renting is currently supplied by humans and rule tables. Owning intelligence, done properly, means turning on and measuring two narrow per-site tasks — not building a migration-planning model.

**One further correction to the program's framing.** The program is built around a rent-versus-own trade. There is no rent bill: every model call site is off by default and no cost number has ever been committed. The near-term justification for owning intelligence here has to be **capability and reliability**, not cost.

## 8. Conclusions

### 8.1 The three strongest OWN_NOW candidates

**There are none.** Under the program's own rule — *if we cannot measure it, we are not ready to train for it* — not one model-mediated task in this product has a quality measurement. The single gated capability measures a path with the model switched off, and it currently fails its own gate.

The three strongest **near-term** candidates, ranked, with the specific measurement that would move each to `OWN_NOW`:

**1. T5 — Call-site classification (Fettler).** Best-shaped target: closed 5-field output, temperature 0, ≤2500-char slice, precision-first objective, genuinely proprietary (slice, change, verdict) triples. **Nearest to measurable of anything in the product** — the 27 `flag_files` scenarios already compute per-site TP/FP/FN against hidden answer keys; they simply never run against the model path. *What would change it:* add a second graded arm to the synthetic runner with `useLlm: true` and a `LLM_CONFIRM=1` mode, and author a `fettler-call-site-confirmation` capability in `readiness-gates.json`. The corpus, the graders and the isolation already exist.

**2. T13 — Adaptive repair edit generation (ReGauge).** Best-instrumented model call in the product, with an objective training label (the verification gate), durable per-call token/cost accounting, seven deterministic output gates, and a precedent loop already wired. This is spec §17.8's framework/runtime adapter. *What would change it:* a ReGauge runner arm that calls `applyRecipe` + `executeRecipeInWorkspace` in a scratch copy and runs the recipe's own verification commands — the compilation and subject's-own-tests graders are already sketched in `evals/graders/DEFERRED.md:8-28` — plus promoting the live eval into a scheduled (not per-PR) workflow.

**3. T3 — Changelog / deprecation-prose interpretation (Fettler).** The largest genuine capability gap where a model beats the deterministic incumbent: six regexes and a 50-word stop list against open-ended provider prose. Small structured output, high repetition, and today's failure mode is a *silent* zero. *What would change it:* a labelled corpus of real provider changelog entries paired with the rename mappings we accepted, plus a counter for how often `changelog-parse.ts` returns zero replacements on a change that later produced findings — so we can size the loss before spending on it.

Two explicit non-recommendations:

- **T12 (residual detection) must not go on the training roadmap**, despite being the biggest correctness hole (12 of 35 false-greens). It is a deterministic detector that was too narrow; PR #174 is the right fix; spec §17.4 forbids training around deterministic defects.
- **T17 (verification reasoning) must never become model-mediated.** A model judging verification would reintroduce the fake-green class the sandbox exists to eliminate.

### 8.2 What is blocking each

| Candidate | Blocker | Owner-facing decision |
| --- | --- | --- |
| T5 call-site classification | **No traffic** — default-off (`llm-confirm.ts:44-49`) | Whether to enable `LLM_CONFIRM` on the eval path (not production) to generate scored examples |
| T5 | **No measurement** — the graded runner sets `useLlm: false` (`fettler-runner.ts:92`) | Adding a second runner arm is a small, contained change to `evals/` |
| T5 | **Provenance poison** — `heuristicConfirm` stamps substring counts as `confirmationPath: "hybrid_llm"` (`llm-confirm.ts:127, 144, 151`) | A distinct `"heuristic"` label already exists in the schema (`packages/shared/src/index.ts:535`) and is simply not used here |
| T5 | **Two divergent classifiers** — `confirm.ts:23-54` and `code-impact/index.ts:243-312` disagree on impact-type ordering and on whether `configuration` forces `low` | Which is canonical must be settled before either becomes a training label |
| T13 adaptive repair | **Three gating flags** plus tenant allowlist plus external-processing approval (`transformer-adaptive-planner.ts:345-367`) | Whether a pilot tenant is authorised to generate governed examples |
| T13 | **Analyze-only eval** — `regauge-runner.ts:183` never applies | Building the apply+verify arm; the deferred graders are already specified |
| T13 | **Residual detection was absent for 4 of 5 families** — any dataset built from pre-#174 "verified" outcomes would encode 12 false successes as positives | PR #174 must land *before* any ReGauge learning capture is enabled |
| T3 changelog prose | **No corpus, no scenario, no counter** | Whether to invest in labelling before the loss is sized |
| All | **Learning capture is default-off** — `learningLoopEnabled` requires `MENDPOINT_REGAUGE_LEARNING_ENABLED=1` (`apps/worker/src/transformer-learning-outcome.ts:310-311`), and admission additionally requires an active consent (`apps/worker/src/warden-learning-producer.ts:70-78`) | Nothing accumulates until this is enabled for a consenting tenant |
| All | **Only one capability has a producer** — both governed learning producers hardcode `capability: "remediation_generation"` (`warden-learning-producer.ts:95`; `transformer-governed-learning-producer.ts:72`), and both record `execution.modelId: null` (`warden-learning-producer.ts:105`) | Spec §17.7's thirteen corpus families have one emitter between them, and it does not record which model produced the outcome |
| All | **Confidence calibration has no emitter** — `packages/graph-learn/src/confidence-calibration.ts` is called only by its own tests | Spec §12.2 requires calibrated confidence; today (2) is an ungated model self-score |
| All | **Router learning has no data** — one eligible executor per pass (`warden-router.ts:154-161`); `router-value-proof.ts` has no producer | Spec §17.12 cannot begin until a second path is genuinely eligible |

### 8.3 Where the program's hypothesis is wrong

1. **"Fettler is measurable" is true of the wrong thing.** The measured Fettler capability runs with the model off. No model-mediated task in either product has any quality measurement.
2. **"Provider-specific" is not the architecture.** The product is deliberately provider-agnostic and treats residual provider literals as defects. A vendor-adapter strategy has nothing to specialise on yet.
3. **"High volume" is an assumption.** The only Fettler model path is off by default and its usage is never counted.
4. **"ReGauge's long-horizon planning benefits from a frontier model" is false.** ReGauge planning, sequencing and architecture reconstruction contain no model at all — the third is model-free *by contract*. The frontier model in ReGauge does short-horizon, single-file, digest-fenced edits.
5. **The rent-versus-own framing does not fit.** There is no rent bill. Every model call site is default-off; no cost number has ever been committed. The case for owning intelligence must be made on capability and reliability.
6. **Fettler's biggest measured gap is off-limits to training.** Recall fails by language and on JSON fixtures — parser and indexer defects. Spec §17.4 forbids fine-tuning to compensate for them.

**What survives.** Fettler *does* hold the best-shaped target — but it is call-site confirmation, a task that is currently switched off, not the impact analysis the measurements describe. And ReGauge holds the best-*instrumented* target, which the hypothesis assigned to the frontier model permanently. The correct sequencing is: land PR #174, build the apply+verify eval arm, add a model arm to the Fettler runner, author gates for both, and only then decide what to train.

## 9. Everywhere this document says "not measured"

Recorded here in one place so the program can price the measurement work.

| # | Not measured | What would measure it |
| --- | --- | --- |
| 1 | **Frequency of every one of the 20 tasks** | No production telemetry is committed. `routing_ledger.task_kind` (`packages/db/src/index.ts:1113`) is the right shape; a per-task-kind volume query against a live deployment would answer it. |
| 2 | **Model cost of every task** | All 43 committed run records carry `"estimated_cost_usd": null`. Run the synthetic suite with `useLlm: true` and project the existing `modelAccounting` receipt (`packages/agent/src/runtime-execution.ts:266`) into the already-present `RunRecord` fields. |
| 3 | **Latency of every model-mediated task** | Only deterministic-path wall clock is recorded (`latest.md:145-147`). `monotonicTimestampMs` is captured per call (`packages/agent/src/model-provenance.ts:100`) but no code derives a per-call duration from it. |
| 4 | **Quality of every model-mediated task (T3, T5, T13, T15-model, T18)** | Add a model arm to the runners and author matching capabilities in `readiness-gates.json`. |
| 5 | **T5 agreement/override rate** — how often the model confirms, contradicts, or is skipped | Aggregate `confirmationPath` (currently written and never read) and log the static verdict alongside the model verdict. |
| 6 | **T3 silent-zero rate** — how often `changelog-parse.ts` finds nothing | A counter on empty `RENAME_PATTERNS` results, joined against changes that later produced findings. |
| 7 | **ReGauge apply correctness, verification honesty, PR delivery, rollback, idempotency** | The harness lists these itself (`latest.md:176-185`). Requires an apply+verify runner arm; graders sketched in `evals/graders/DEFERRED.md:8-28`. |
| 8 | **ReGauge site-level precision/recall** | `readiness-scorecard.md:48` — "apply path not exercised". Same fix as #7. |
| 9 | **ReGauge holdout performance** | `readiness-scorecard.md:47` — holdout generation currently targets Fettler ref-rename families only. Extend `evals/generators/families.ts`. |
| 10 | **Fettler patch-verification rate** | `readiness-scorecard.md:24` — the generation + sandbox path is not exercised by the analysis-only runner. |
| 11 | **Confidence calibration (ECE, Brier, selective accuracy) for any phase** | The harness exists (`packages/graph-learn/src/confidence-calibration.ts`); it needs a production emitter of `ConfidenceCalibrationSample`. |
| 12 | **Router value — cost/latency/acceptance per execution path** | `packages/eval/src/router-value-proof.ts` is a validator with no producer. Requires ≥2 genuinely eligible executors per pass first. |
| 13 | **Volume of governed proprietary training data** | Learning capture is default-off; no record count is committed. Enable for a consenting tenant and count `learning_records`. |
| 14 | **Which model produced any governed learning event** | Both producers write `execution.modelId: null` (`apps/worker/src/warden-learning-producer.ts:105`). Fixing this is a prerequisite for spec §17.12 router learning. |
| 15 | **Observed performance percentiles** | `docs/PERFORMANCE_CONTRACT.md:3` states the objectives are *"not a public SLA and must not be presented as observed performance"*; the runner writes to gitignored `runs/`. |
| 16 | **Model-as-judge / inter-rater agreement** | No LLM grader exists anywhere (`evals/graders/fettler-graders.ts:12` — "No LLM judging"). Two semantic rubrics are sketched, unbuilt, in `evals/graders/DEFERRED.md:47-65`. |
| 17 | **Quality of T1, T2, T6-T11, T14, T17, T19-T22 individually** | Each is folded into an aggregate or has no grader at all. Per-task graders would be needed to make any of them a training target — which for the deterministic ones is not the recommendation. |

---

*Analysis by Claude Code. No product code was read into any model beyond this repository's own tooling, and no file outside `docs/intelligence/` was modified.*
