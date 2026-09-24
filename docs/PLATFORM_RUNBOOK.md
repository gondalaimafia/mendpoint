# Platform runbook — specialist handoff

## Bring-up

```bash
npm install
npm run platform:dev    # graph + harness + git temporal + SLO + dogfood seed
npm test
npm run dev:api         # optional API on :3001
```

## Day-90 ops CLIs

```bash
npm run graph:temporal -- . --months=12 --max=2000   # git → graph-learn
npm run graph:slo                                     # p50/p99 latency gate
npm run dogfood:report                                # ≥30 REAL runs / ≥50% ok (refuses if synthetic present)
npm run trajectory:list                               # list runs/
npm run trajectory:view -- <runId>                    # plan/trace/score
npm run graph:bench                                   # 20-query pack
```

## Platform API / web (outstanding closure)

| Surface | Path |
|---------|------|
| Platform home | Web `/platform` |
| Dogfood | `GET /platform/dogfood` · `/platform/dogfood` |
| Trajectories | `GET /platform/trajectories` · UI |
| HITL plans | `GET/PATCH /platform/plans/:runId` · `/platform/plans` |
| VM status | `GET /platform/vm` |
| Live sandbox | `POST /platform/live-sandbox` |
| SCM adapters | `GET /platform/scm` |
| Alerts | `GET /platform/alerts` |
| NL graph pick | `POST /graph-learn/pick` `{ "q": "...", "run": true }` |
| AST / LSP / incremental | `POST /graph-learn/ast-ingest` · `lsp-ingest` · `incremental` |
| Meta-graph promote | `POST /graph-learn/promote-patterns` |
| A/B lift | `GET /graph-learn/ab` |
| GNN export | `GET /graph-learn/gnn-export` |

SDK: `createPlatform()` exposes `pickQuery`, `ingestAst`, `ingestLsp`, `incremental`, `gnnExport`, `promotePatterns`, `abLift`, `createVm`, `liveSandbox`, `editPlan`, `estimateCost`, …

## Depth upgrades (post Day-90)

| Item | How |
|------|-----|
| Per-file incremental | Hash delta + **replace subgraph** on change; **hard-delete** removed files |
| Multi-SCM | GitHub/GitLab/Bitbucket/ADO adapters — mock without token, live with env |
| Harness tools | Real contract/transformer/graph-learn; `graph.stats` / `graph.query` |
| PR experiment → A/B | Tagged-only lift + Wilson CI + two-proportion **z/p-value** |
| Alerts | JSONL dedupe load at `data/alerts.jsonl` |
| RBAC | Sensitive GETs + mutations via `permissionForRoute` |
| Embeddings | Stable hash vectors (force recompute option); included in GNN `x` |
| Kùzu path | `createRequire` status + export script + optional `tryOpenKuzu` |

## Platform SDK (`@mendpoint/sdk`)

```ts
import { createPlatform } from "@mendpoint/sdk";

const p = createPlatform();
p.graphQuery({ op: "stats" });
const plan = p.planSpecDiff({ ... });
const run = await p.executeHello();
p.recordOutcome({ prId, changeId, consumerId, outcome: "merged" });
p.backfillGit({ repoPath: ".", months: 12 });
p.latencySlo();
p.dogfood();
```

## Add a graph node/edge type

1. Extend `GlNodeKind` / `GlEdgeKind` in `packages/graph-learn/src/schema.ts`  
2. Write ingest helper in `ingest.ts`  
3. Add query template if needed in `query.ts`  
4. Document in `GRAPH_SCHEMA_V0.md`  

## Add a harness tool

1. Register in plan step `action` string  
2. Handle in `@mendpoint/harness` executor switch  
3. Emit structured errors (deterministic recovery)  

## Outcome edges

| Feedback | Edge |
|----------|------|
| PR merged | `outcome_merged` |
| PR closed | `outcome_closed` + often `outcome_broke` |
| Waived | `outcome_waived` |

Query: `{ "op": "outcomes_for_pattern", "pattern": "amount" }`

## Specialist stubs

- `packages/sdk/src/specialists/warden-stub.ts` — adds spec-diff plan step  
- `packages/sdk/src/specialists/transformer-stub.ts` — adds BSG/DAG plan step  

## Kill-switches (from 90-day plan)

- Graph ingest broken → stay on heuristic index, no LSP  
- Dogfood thin → freeze features, fix harness  
- Outcome pipeline flaky → ship without learned signal  

## Self-serve provider slugs (reservation + namespacing)

`providers.slug` is globally UNIQUE. Under self-serve (`MENDPOINT_SELF_SERVE_WARDEN` /
`MENDPOINT_SELF_SERVE_FETTLER`), `POST /providers` for a tenant:

- refuses a slug reserved for the shared catalog (a `VENDOR_CATALOG` vendor slug or an existing
  shared provider row) with `409 provider_slug_reserved`; and
- namespaces the stored slug as `<tenantId>~<requested>` so it can never collide with a current
  or future shared vendor. The effective slug is returned in the create response and is what the
  tenant's routes address.

A create colliding with any existing slug returns `409 provider_slug_unavailable` (never 500,
never revealing whether the taken slug is shared or another tenant's private one).

### Legacy squatted private row (operator path)

If a tenant created a PRIVATE provider under a bare, now-reserved slug BEFORE this change (a
row with a non-null `tenant_id` whose bare slug matches a shared vendor), there is no automatic
data move. Production has no private providers today (self-serve off, one tenant), so this is a
forward-looking procedure only. To remediate, an operator (system-catalog admin) should, in one
transaction: repoint that provider's dependents to the intended shared provider, or rename the
squatted row's slug to the namespaced form `UPDATE providers SET slug = '<tenantId>~<slug>'
WHERE id = '<providerId>' AND tenant_id = '<tenantId>'` (and update any cached slug references),
then create the shared vendor row under the freed bare slug. Never bulk-rewrite slugs blindly:
verify each dependent (versions, changes, monitored_apis) before and after.

## Out of platform scope

GNN training, Neo4j, multi-tenant RBAC, browser tool, full Fettler/Regauge product logic.
