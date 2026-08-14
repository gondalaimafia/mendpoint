# Gauge training — API communication failures

**Gauge** is Mendpoint’s API debug agent. It is trained on the full stack of **API communication failure modes** (protocol/contract, serialization, semantics, network, cascading errors, async/webhooks, rate limits) — not just path typos.

## Categories

| Category | Client-fixable (Gauge) | FDE / infra |
|----------|--------------------------|-------------|
| Protocol & contract | Paths, Content-Type, Accept, version headers, GraphQL body shape, trailing slash, gRPC/JSON hints | Mesh, gateway schema translation |
| Serialization drift | Field renames, enum/date hints, snake/camel when stated | Producer versioning governance |
| Semantic mismatch | Units (cents), epoch scale, prefer live errors over stale docs | Canonical data models across orgs |
| Network & latency | https, timeouts, request-id headers | NTP/clock skew, gateway 504 routing, pool sizing |
| Cascading errors | Backoff+jitter, no 4xx retries, Idempotency-Key, status checks, simple circuit pattern | Bulkheads at platform layer |
| Async / webhooks | Event-id dedupe, signature verification guidance | Provider retry SLAs, DLQs |
| Rate limiting | 429 + Retry-After, concurrency hints | Shared quotas, gateway throttles |

## Runtime model

1. **`classifyFailures(goal, errorLog, code)`** → ranked mode ids  
2. **Heuristic tool loop** (list → search → read → `proposeWardenFix` → verify)  
3. Optional **LLM planner** seeded with `wardenPlaybook()` + diagnosed modes  
4. Report lists **diagnosed modes** and FDE handoff flags  

Code:

- `packages/agent/src/knowledge.ts` — mode catalog  
- `packages/agent/src/fixes.ts` — surgical code fixes  
- `packages/agent/src/heuristics.ts` — planner  
- Entry: `runWarden()`  

## What Gauge will *not* pretend to fix alone

- Production gateway misconfiguration without client repro  
- NTP/clock skew on identity infrastructure  
- CAP/partition strategy across data centers  
- Cross-org semantic dictionary design  

Those surface as **FDE handoff** in the Gauge report.

## Verify

```bash
npm test -w @mendpoint/agent
npm run agent:demo
```
