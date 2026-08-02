# Performance contract

Status: internal pilot release gate. These objectives are not a public SLA and must not be presented as observed performance until a revision bound run is recorded.

The executable source of truth is `WARDEN_PERFORMANCE_CONTRACT` in `packages/eval/src/performance-contract.ts`. The evaluator uses nearest rank percentiles, rejects incomplete cohorts, and fails a metric when any work item fails or when p50, p95, or p99 exceeds its objective.

## Workload tiers

| Tier | Repository ceiling | Languages | Concurrency | Minimum samples | Load | Soak |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `pilot-small` | 5,000 files, 50 MB | TypeScript | 2 | 100 per metric | 5 minutes | 1 hour |
| `pilot-medium` | 25,000 files, 500 MB | JavaScript, Python, TypeScript | 5 | 100 per metric | 10 minutes | 2 hours |

Repositories above the selected ceiling are out of scope for that run. The exact repository revision, generated fixture digest, deployment revision, worker count, and dependency versions must be attached to the observation set.

## Objectives

| Metric | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| First result | 60 seconds | 3 minutes | 5 minutes |
| Complete scan | 5 minutes | 15 minutes | 30 minutes |
| Verification | 2 minutes | 10 minutes | 20 minutes |
| Queue wait | 5 seconds | 30 seconds | 60 seconds |
| Campaign fanout | 30 seconds | 2 minutes | 5 minutes |

## Release gate

A candidate must pass both load and soak modes for its advertised tier. Reports must retain every observation, including failures and retries. Results from synthetic fixtures prove only the named fixture and tier. Customer workload claims require separate observed customer evidence and approval through the public claim registry.

## Executable probe

The runner sends bounded concurrent requests to an instrumented probe endpoint. Each successful response must return the exact deployment revision and one timing for every contract metric:

```json
{
  "deploymentRevision": "<immutable deployment id>",
  "metrics": {
    "first_result": { "durationMs": 1000, "success": true },
    "complete_scan": { "durationMs": 2000, "success": true },
    "verification": { "durationMs": 500, "success": true },
    "queue_wait": { "durationMs": 20, "success": true },
    "campaign_fanout": { "durationMs": 750, "success": true }
  }
}
```

Run a suite with:

```text
npm run eval:performance -- --mode=load --tier=pilot-small --endpoint=https://deployment.example/internal/performance-probe --deployment-revision=<immutable-id> --fixture-digest=<sha256> --output=runs/performance/load.json
```

Use `mode=soak` for the soak gate. The runner derives the repository revision and dependency versions locally, uses the selected tier's concurrency and duration without overrides, aborts in flight requests at the deadline, and writes the report atomically. Set `MENDPOINT_PERFORMANCE_BEARER_TOKEN` when the internal endpoint requires bearer authentication. An operator interrupt produces an aborted report and a failing exit code. A report is complete only when every metric reaches the tier's minimum sample count.
