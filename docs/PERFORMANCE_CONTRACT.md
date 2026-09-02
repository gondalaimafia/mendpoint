# Fettler performance contract

Status: internal production qualification gate. These objectives are not a public service level agreement. A result supports only the exact tenant, repository revision, deployment revision, fixture, probe source, tier, and correlation recorded by the executable report.

The executable source of truth is `FETTLER_PERFORMANCE_CONTRACT` in `packages/eval/src/performance-contract.ts`. The evaluator uses nearest-rank percentiles, rejects incomplete cohorts, and fails a metric when any work item fails or when p50, p95, or p99 exceeds its tier-specific objective.

## Representative workload tiers

| Tier | Repository floor | Repository ceiling | Required language distribution | Concurrency | Minimum samples | Load | Soak |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| `small` | 1,000 files, 50,000 source lines, 25 MB | 2,000 files, 100,000 source lines, 50 MB | TypeScript at least 100% | 2 | 100 per metric | 5 minutes | 1 hour |
| `medium` | 10,000 files, 500,000 source lines, 250 MB | 20,000 files, 1,000,000 source lines, 500 MB | JavaScript, Python, and TypeScript at least 20% each | 4 | 100 per metric | 10 minutes | 2 hours |
| `large` | 50,000 files, 2,500,000 source lines, 1.25 GB | 100,000 files, 5,000,000 source lines, 2.5 GB | Go, Java, JavaScript, Python, Ruby, and TypeScript at least 10% each | 8 | 100 per metric | 20 minutes | 4 hours |

The measured repository must fall within every floor and ceiling. Its per-language source-line counts must add exactly to the measured total and satisfy each minimum distribution. A smaller, oversized, or unrepresentative fixture fails closed. The legacy command inputs `pilot-small`, `pilot-medium`, and `pilot-large` remain accepted as compatibility aliases, but reports and new documentation always emit `small`, `medium`, or `large`.

## Tier-specific objectives

| Tier | Metric | p50 | p95 | p99 |
| --- | --- | ---: | ---: | ---: |
| small | First result | 30 seconds | 90 seconds | 3 minutes |
| small | Complete scan | 2 minutes | 6 minutes | 12 minutes |
| small | Verification | 1 minute | 4 minutes | 8 minutes |
| small | Queue wait | 2 seconds | 10 seconds | 30 seconds |
| small | Campaign fanout | 15 seconds | 1 minute | 2 minutes |
| medium | First result | 60 seconds | 3 minutes | 5 minutes |
| medium | Complete scan | 5 minutes | 15 minutes | 30 minutes |
| medium | Verification | 2 minutes | 10 minutes | 20 minutes |
| medium | Queue wait | 5 seconds | 30 seconds | 60 seconds |
| medium | Campaign fanout | 30 seconds | 2 minutes | 5 minutes |
| large | First result | 2 minutes | 6 minutes | 10 minutes |
| large | Complete scan | 10 minutes | 30 minutes | 60 minutes |
| large | Verification | 5 minutes | 20 minutes | 40 minutes |
| large | Queue wait | 10 seconds | 60 seconds | 2 minutes |
| large | Campaign fanout | 1 minute | 5 minutes | 10 minutes |

## Producer-observed evidence

The runner supplies an expected binding to an instrumented probe. A successful probe response must return the identities and measured repository shape it actually observed, followed by one nonzero timing for every metric:

```json
{
  "observed": {
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
      "languages": ["typescript"],
      "languageSourceLines": { "typescript": 50000 }
    }
  },
  "metrics": {
    "first_result": { "durationMs": 1000, "success": true },
    "complete_scan": { "durationMs": 2000, "success": true },
    "verification": { "durationMs": 500, "success": true },
    "queue_wait": { "durationMs": 20, "success": true },
    "campaign_fanout": { "durationMs": 750, "success": true }
  }
}
```

Every observed identity and repository field must exactly match the requested binding. The runner measures peak concurrency and the nonzero run interval itself. Declared strings alone are not evidence.

Each metric dictionary entry owns an `eventSource`. Observations must carry that exact event source. The separate report-level `probeSource` identifies the producing probe implementation and cannot substitute for the metric event source.

## Operator command

Run the canonical small load gate with all authority bindings:

```text
npm run eval:performance -- --mode=load --tier=small --endpoint=https://deployment.example/internal/performance-probe --tenant-id=tenant-example --repository-id=repository-example --repository-revision=<immutable-source-revision> --deployment-revision=<immutable-deployment-revision> --fixture-digest=sha256:<fixture-digest> --correlation-id=<unique-correlation> --probe-source=fettler-production-probe --output=runs/performance/load.json
```

Use `mode=soak` for the soak gate. The runner uses the tier's fixed concurrency and duration, sends the expected repository shape to the probe, aborts in-flight requests at the deadline, and writes the report atomically. Set `MENDPOINT_PERFORMANCE_BEARER_TOKEN` when the internal endpoint requires bearer authentication.

An operator interrupt produces an aborted report and a failing exit code. A thrown failure before producer observation is retained as a failed sample with a minimum one millisecond duration and request-context provenance; the report remains incomplete and cannot qualify production. A report completes only when every metric reaches the tier's minimum sample count with exact producer-observed bindings.

## Claim boundary

A candidate must pass load and soak modes for its advertised tier. Reports retain every observation, including failures and retries. Synthetic fixtures prove only the named fixture and tier. Customer workload claims require separate observed customer evidence and approval through the public claim registry.
