# Mendpoint — Graph Native (Phase F)

## North star

**Mendpoint is a graph of API change → code impact → human decision.**  
The product still ships reviewable PRs; **graphs** are how we reason, orchestrate agents, and earn trust.

This covers **domain graphs** (code/API/product). For **agent orchestration graphs** (graph engineering vs loop engineering), see [`GRAPH_ENGINEERING.md`](./GRAPH_ENGINEERING.md) — that is the go-to agentic approach.

## Phases

| Phase | Surface | Status |
|-------|---------|--------|
| **F1** | Impact graph explorer (blast radius) | Implemented |
| **F2** | API surface / change graph | Implemented |
| **F3** | Control-plane product knowledge graph | Implemented (SQLite projection) |

## Product graph model

```ts
type GraphNode = {
  id: string;
  kind: "surface" | "finding" | "function" | "file" | "provider" | "version"
    | "change" | "consumer" | "pr" | "tenant" | "installation";
  label: string;
  meta?: Record<string, unknown>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string; // IMPACTS | CALLS | RENAMES_TO | MONITORS | OPENED_PR | ...
  meta?: Record<string, unknown>;
};

type ProductGraph = {
  id: string;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layoutHints?: { ranks?: Record<string, number> };
};
```

## APIs

| Route | Purpose |
|-------|---------|
| `GET /graph/changes/:id` | Impact + API delta graph for a stored change |
| `GET /graph/consumers/:id?changeId=` | Consumer-scoped impact subgraph |
| `GET /graph/product` | Control-plane knowledge graph (optional `?focus=provider:slug`) |
| `GET /graph/api/:providerSlug` | API surface graph between latest two versions |

## UI

- `/graph` — explorer (pick change / product overview)
- Change detail links into graph view

## Invariants

1. Domain graph is **read-mostly**; mutations go through pipeline + PR  
2. Code nodes carry evidence (file, line, confidence)  
3. No auto-merge  
4. Product control flow is an **agent graph** (not one free-roam loop); each stage is a loop node  
5. Fan-out expand / fan-in confirm preferred over sequential whole-repo mud  

## Implementation packages

- `@mendpoint/graph` — builders + serializers (domain product graphs)  
- `@mendpoint/orchestrator` — agent graph topology + runner  
- Reuses `@mendpoint/call-graph`, `change-intel`, `db`, `codebase-index`
