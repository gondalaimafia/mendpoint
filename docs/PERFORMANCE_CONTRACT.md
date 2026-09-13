# Fettler performance contract

Status: internal production qualification gate. These objectives are not a public service level agreement. A result supports only the exact tenant, repository revision, deployment revision, fixture, probe source, tier, and correlation recorded by the executable report.

The executable source of truth is `FETTLER_PERFORMANCE_CONTRACT` in `packages/eval/src/performance-contract.ts`. The evaluator uses nearest-rank percentiles, rejects incomplete cohorts, and fails a metric when any work item fails or when p50, p95, or p99 exceeds its tier-specific objective.

## Representative workload tiers

| Tier | Repository floor | Repository ceiling | Maximum file | Required language distribution | Concurrency | Minimum samples | Load | Soak |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| `small` | 1,000 files, 50,000 source lines, 25 MB | 2,000 files, 100,000 source lines, 50 MB | 1 MB | TypeScript at least 100% | 2 | 100 per metric | 5 minutes | 1 hour |
| `medium` | 10,000 files, 500,000 source lines, 250 MB | 20,000 files, 1,000,000 source lines, 500 MB | 5 MB | JavaScript, Python, and TypeScript at least 20% each | 4 | 100 per metric | 10 minutes | 2 hours |
| `large` | 50,000 files, 2,500,000 source lines, 1.25 GB | 100,000 files, 5,000,000 source lines, 2.5 GB | 10 MB | Go, Java, JavaScript, Python, Ruby, and TypeScript at least 10% each | 8 | 100 per metric | 15 minutes | 4 hours |

The measured repository must fall within every floor and ceiling. The producer must also report the largest observed file in bytes, and that value must not exceed the tier's maximum file size. Its per-language source-line counts must add exactly to the measured total and satisfy each minimum distribution. A smaller, oversized, or unrepresentative fixture fails closed. The legacy command inputs `pilot-small`, `pilot-medium`, and `pilot-large` remain accepted as compatibility aliases, but reports and new documentation always emit `small`, `medium`, or `large`.

## Tier-specific objectives

| Tier | Metric | p50 | p95 | p99 |
| --- | --- | ---: | ---: | ---: |
| small | First result | 30 seconds | 90 seconds | 3 minutes |
| small | Complete scan | 2 minutes | 5 minutes | 8 minutes |
| small | Verification | 5 minutes | 15 minutes | 25 minutes |
| small | Queue wait | 5 seconds | 30 seconds | 1 minute |
| small | Campaign fanout | 30 seconds | 2 minutes | 5 minutes |
| medium | First result | 90 seconds | 4 minutes | 8 minutes |
| medium | Complete scan | 10 minutes | 25 minutes | 40 minutes |
| medium | Verification | 15 minutes | 40 minutes | 60 minutes |
| medium | Queue wait | 10 seconds | 1 minute | 2 minutes |
| medium | Campaign fanout | 1 minute | 4 minutes | 10 minutes |
| large | First result | 4 minutes | 10 minutes | 20 minutes |
| large | Complete scan | 35 minutes | 75 minutes | 120 minutes |
| large | Verification | 45 minutes | 120 minutes | 180 minutes |
| large | Queue wait | 30 seconds | 2 minutes | 5 minutes |
| large | Campaign fanout | 2 minutes | 10 minutes | 20 minutes |

## Producer-observed evidence

The runner supplies an expected binding to an instrumented probe. A successful probe response must return the identities and measured repository shape it actually observed, followed by one nonzero timing for every metric:

```json
{
  "observed": {
    "invocationId": "small.load.00000000",
    "invocationNonce": "<fresh producer nonce>",
    "sequence": 0,
    "observedAt": "<producer observation time>",
    "tenantId": "tenant-example",
    "repositoryId": "repository-example",
    "repositoryRevision": "<immutable source revision>",
    "deploymentRevision": "<immutable deployment revision>",
    "fixtureDigest": "sha256:<fixture digest>",
    "correlationId": "<unique run correlation>",
    "probeSource": "fettler-production-probe",
    "repository": {
      "files": 1000,
      "sourceLines": 50000,
      "bytes": 25000000,
      "maxFileBytes": 1000000,
      "languages": ["typescript"],
      "languageSourceLines": { "typescript": 50000 }
    }
  },
  "metrics": {
    "first_result": { "durationMs": 1000, "success": true, "eventSource": "fettler.performance.first_result" },
    "complete_scan": { "durationMs": 2000, "success": true, "eventSource": "fettler.performance.complete_scan" },
    "verification": { "durationMs": 500, "success": true, "eventSource": "fettler.performance.verification" },
    "queue_wait": { "durationMs": 20, "success": true, "eventSource": "fettler.performance.queue_wait" },
    "campaign_fanout": { "durationMs": 750, "success": true, "eventSource": "fettler.performance.campaign_fanout" }
  }
}
```

Every observed identity and repository field must exactly match the requested binding. The persisted observation retains the exact invocation identifier, fresh nonce, producer sequence, producer timestamp, and metric event source that passed validation. The runner measures peak concurrency and the nonzero run interval itself. Declared strings alone are not evidence.

Each metric dictionary entry owns an `eventSource`. Observations must carry that exact event source. The separate report-level `probeSource` identifies the producing probe implementation and cannot substitute for the metric event source.

## Operator command

Run the canonical small load gate with all authority bindings:

```text
npm run eval:performance -- --mode=load --tier=small --endpoint=https://deployment.example/internal/performance-probe --tenant-id=tenant-example --repository-id=repository-example --repository-revision=<immutable-source-revision> --deployment-revision=<immutable-deployment-revision> --fixture-digest=sha256:<fixture-digest> --correlation-id=<unique-correlation> --probe-source=fettler-production-probe --repository-files=1000 --repository-source-lines=50000 --repository-bytes=25000000 --repository-max-file-bytes=1000000 --repository-languages=typescript --repository-language-source-lines=typescript:50000 --output=runs/performance/load.json
```

Use `mode=soak` for the soak gate. The runner uses the tier's fixed concurrency and duration, sends the expected repository shape to the probe, aborts in-flight requests at the deadline, and writes the report atomically. Set `MENDPOINT_PERFORMANCE_BEARER_TOKEN` when the internal endpoint requires bearer authentication. Probe responses are limited to 1,048,576 bytes. Declared or streamed responses above that boundary fail with `performance_probe_response_too_large` before JSON parsing.

An operator interrupt produces an aborted report and a failing exit code. A thrown failure before producer observation is retained as a failed sample with a minimum one millisecond duration and request-context provenance; the report remains incomplete and records `probe_failure_unobserved`. A run that reaches its duration without enough complete evidence records `duration_elapsed`. A report completes only when every metric reaches the tier's minimum sample count with exact producer-observed bindings.

The schema version 3 report enforces an in-memory raw-evidence budget of 10,000 observations. When a healthy run exceeds that bound, deterministic stride sampling thins complete invocation groups across the full run instead of stopping the probe. The report retains the sampling stride, total invocation count, retained and dropped observation counts, per-metric counts, failures, duration range, fixed histogram, exact counts within each p50, p95, and p99 objective, and an aggregate digest over every observed invocation. Qualification uses those complete objective counts, so raw sampling cannot hide an unsampled slow cohort. A producer failure still fails closed; only successful raw detail is thinned. This keeps publication bounded while preserving auditable provenance and complete aggregate accounting for high-throughput load and soak runs.

## Claim boundary

A candidate must pass load and soak modes for its advertised tier. Reports retain every observation until the 10,000-observation raw-evidence budget is reached, then retain deterministic representative detail and sealed aggregate accounting. Synthetic fixtures prove only the named fixture and tier. Customer workload claims require separate observed customer evidence and approval through the public claim registry.
