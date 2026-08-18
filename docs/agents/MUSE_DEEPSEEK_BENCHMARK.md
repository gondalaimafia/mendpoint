# Muse 1.2 and DeepSeek V4 Flash verifier benchmark

Status: benchmark harness verified, live model comparison blocked.

## Decision

Mendpoint must remain at `off`, `offline`, or `shadow` for this verifier. No retained live DeepSeek V4 Flash run exists in this branch because `DEEPSEEK_API_KEY` is not available in the execution environment. Fixture evidence proves the benchmark and safety paths, but it does not prove model quality, calibration, independence, latency, or economics.

DeepSeek selection must not change Fettler or ReGauge behavior until a sealed holdout run clears the quality, safety, calibration, and cost gates below. The current worker rejects `selective` and `automated` rollout modes.

## Canonical experiment

Every task supplies one sealed holdout revision and one identical Muse candidate pool to four arms:

1. Muse 1.2 Pass at 1.
2. Muse 1.2 self selected Best of N.
3. DeepSeek V4 Flash selected Best of N.
4. Oracle Best of N.

The harness supports candidate counts 1 to 5 and reports success rate, absolute and relative lift, selection accuracy, oracle gap, misranking, false confidence, caught Muse errors, introduced errors, generation and verification tokens, total cost, latency, calibration, and incremental cost per additional successful task.

The holdout contract binds the cohort revision and digest, requires `split=holdout`, keeps answer keys outside verifier evidence, and rejects evidence that names a correct or winning candidate. The verifier sees only bounded observable evidence. It never receives private model reasoning.

## Retained fixture proof

The deterministic fixture contains one Fettler task and one ReGauge task with three candidates each. It deliberately makes the first Muse candidate wrong on one task. The controlled DeepSeek backend selects the sealed winner while the controlled Muse self verifier keeps the incumbent.

| N | Muse Pass at 1 | Muse self selected | DeepSeek selected | Oracle |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 50 percent | 50 percent | 50 percent | 50 percent |
| 2 | 50 percent | 50 percent | 100 percent | 100 percent |
| 3 | 50 percent | 50 percent | 100 percent | 100 percent |

This is a harness fixture, not evidence that the real models achieve those rates. Its purpose is to prove the calculation, calibration, economics, answer key separation, and four arm comparison paths.

## Live admission gates

A live report is eligible for rollout review only when all conditions are met:

- The cohort contains both Fettler and ReGauge tasks and has a sealed revision and digest.
- No training, development, or validation scenario appears in the holdout manifest.
- Muse 1.2 and DeepSeek V4 Flash model identities and provider revisions are exact.
- DeepSeek produces positive held out lift over Muse Pass at 1 without introducing a severe deterministic or safety regression.
- Misranking and false confidence remain below the approved capability thresholds.
- Calibration is reported for the complete cohort and relevant risk classes.
- Incremental cost and latency fit the approved tenant budgets.
- The result is reproducible from retained task, candidate, configuration, grader, and report digests.
- A human approves any move beyond shadow.

## Required live command boundary

Live evaluation is opt in. It requires a protected `DEEPSEEK_API_KEY`, explicit external model governance for every task, versioned pricing, and the `offline` evaluation mode. Missing credentials or policy produce a blocked result. They must never be replaced with a mock success.

## Next evidence step

After the independent synthetic harness is committed on current main, adapt its sealed holdout records to `MuseDeepSeekBenchmarkTask` without exposing answer keys to either model. Run N equals 1, 2, 3, and 5 where every task has enough independently generated Muse candidates. Retain the JSON report and this rendered Markdown next to the exact source revision. Only that report can answer whether DeepSeek V4 Flash measurably improves Muse 1.2 for a specific task family and candidate count.
