# Platform runbook — specialist handoff

## Bring-up

```bash
npm install
npm run platform:dev    # seed graph + hello harness run + stats
npm test
npm run dev:api         # optional API on :3001
```

## Platform SDK (`@mendpoint/sdk`)

```ts
import { createPlatform } from "@mendpoint/sdk";

const p = createPlatform();
p.graphQuery({ op: "stats" });
const plan = p.planSpecDiff({ ... });
const run = await p.executeHello();
p.recordOutcome({ prId, changeId, consumerId, outcome: "merged" });
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

## Out of platform scope

GNN training, Neo4j, multi-tenant RBAC, browser tool, full Warden/Transformer product logic.
