# Graph engineering — Mendpoint’s go-to agentic approach

**Canonical doctrine.** Absorbed from [Graph Engineering vs Loop Engineering](https://www.aibuilderclub.com/blog/graph-engineering-vs-loop-engineering) (AI Builder Club) and applied to Warden / Mendpoint.

> Graph engineering isn’t the death of loop engineering — it’s what you reach for when one loop isn’t enough, and **every node in the graph is still a loop**.

---

## Definitions we use

| | **Loop engineering** | **Graph engineering** |
|--|----------------------|------------------------|
| Unit | One agent’s cycle | Multiple **nodes** + **edges** + **shared state** |
| Shape | discover → plan → execute → **verify** → repeat | Directed graph: specialized nodes, routing edges |
| You design | Cycle + stop condition | **Topology + routing** |
| Fails when | Verifier is weak | Topology wrong, or state leaks between nodes |
| Mendpoint examples | Warden tool loop; repair session loop | Change → impact fan-out → generate → verify → review **org chart** |

**One-line test:** if you can name specialized roles and draw arrows between them, you have a graph. If it’s one job that repeats until right, keep a loop.

**We default to graphs for product work.** Single-agent loops are valid *nodes* (Warden, repair). They are not the whole system.

---

## Five layers (outermost = graph)

From the same framing (Prompt → Context → Harness → Loop → **Graph**):

1. **Prompt** — per-node system/user instructions (Warden playbook, LLM confirm)  
2. **Context** — clean inputs per node (impact slice ≠ raw HTML dump; OpenAPI surfaces ≠ whole repo)  
3. **Harness** — tools, sandbox, policy denylist, never auto-merge  
4. **Loop** — each node’s discover/plan/act/verify until stop  
5. **Graph** — topology that wires nodes; **this is our default architecture layer**

---

## What “graph” means here (two complementary graphs)

### 1. Product / code graphs (domain)

- Call graph, e-graph rewrites, API surface graph, product knowledge graph  
- Answer: *what is connected, what breaks, what rewrites are equivalent*  
- Packages: `@mendpoint/call-graph`, `@mendpoint/egraph`, `@mendpoint/graph`

### 2. Agent orchestration graph (control flow)

- Specialized **steps/agents** as nodes; **edges** for sequence, branch, fan-out/fan-in  
- Shared **state** along edges (change, surfaces, findings, draft, verify result)  
- Package: `@mendpoint/orchestrator`  
- Product loop stages are **nodes**, not one muddying context

Both are required. Domain graphs make impact **true**. Orchestration graphs make agent work **auditable and parallelizable**.

---

## Go-to topology (Warden product graph)

```text
                    ┌──────────────┐
  change event ───►│ change_intel  │── surfaces ──┐
                    └──────────────┘              │
                                                  ▼
                    ┌──────────────┐         ┌────────────┐
                    │ index_code   │────────►│ candidates │── fan-out
                    └──────────────┘         └─────┬──────┘
                                                   │
                         ┌─────────────────────────┼─────────────────────────┐
                         ▼                         ▼                         ▼
                   ┌───────────┐            ┌───────────┐            ┌───────────┐
                   │ expand_g  │            │ expand_g  │   …        │ expand_g  │
                   │ (callers) │            │           │            │           │
                   └─────┬─────┘            └─────┬─────┘            └─────┬─────┘
                         └─────────────────────────┼─────────────────────────┘
                                                   ▼ fan-in
                                            ┌────────────┐
                                            │  confirm   │ (static ± LLM slice)
                                            └─────┬──────┘
                                                  ▼
                                            ┌────────────┐
                                            │  generate  │ (patch + PR body)
                                            └─────┬──────┘
                                                  ▼
                                            ┌────────────┐
                     fail ◄─────────────────│   verify   │──► pass
                     │     (repair/Warden   │   (loop)   │
                     │      loop node)      └─────┬──────┘
                     └──────────► generate        ▼
                                            ┌────────────┐
                                            │ review_gate│ (human; never auto-merge)
                                            └────────────┘
```

| Node | Loop inside? | Clean context |
|------|--------------|---------------|
| `change_intel` | bounded normalize | OpenAPI pair + notes only |
| `index_code` | index build | repo root |
| `candidates` | high-recall filter | surfaces + index |
| `expand` | graph hops | candidate + call graph |
| `confirm` | static/LLM | **slice only**, not whole repo |
| `generate` | deterministic edits | findings + files |
| `verify` | **Warden / repair loop** | goal + verify command + repo |
| `review_gate` | policy | draft + labels; human |

**Genuinely new vs one overloaded agent:** parallel expand over candidates (fan-out), confirm never sees raw full-repo soup, verify is a **fresh loop** (not self-rubber-stamp inside generate), control flow is a diagram (orchestrator), not a mystery transcript.

---

## Decision rule (when to stay a loop)

| Stay **loop-only** | Promote to **graph** |
|--------------------|----------------------|
| One specialty (e.g. Warden fix given goal) | Distinct specialties (intel vs scan vs patch vs review) |
| Sequential is fine | Need fan-out (many call sites / many consumers) |
| Implicit routing OK | Need auditable “if verify fail → repair” edges |
| Single model/tools | Different tools per stage |

**Default for Mendpoint product features: graph.**  
**Default for a single node’s internals: tight loop with a strong verifier.**

---

## Anti-patterns we reject

1. **One mega-agent** that searches, patches, and “reviews” itself in one context  
2. **Drawing a flowchart** but still one sequential script with no state schema (fake graph)  
3. **Graph without verifiers** — prettier failure  
4. **State leak** — writer/generate must not receive raw unscoped search dumps  
5. **Auto-merge** as a graph edge to production — never default

---

## Implementation map

| Concern | Where |
|---------|--------|
| Orchestration graph types + runner | `@mendpoint/orchestrator` |
| Canonical product topology | `wardenProductGraph()` in orchestrator |
| Domain call/impact graphs | `@mendpoint/call-graph`, `@mendpoint/code-impact` |
| Product UI graphs | `@mendpoint/graph`, `/graph` |
| Loop node: API debug | `@mendpoint/agent` `runWarden` |
| Loop node: batch repair | `@mendpoint/repair` |
| Pipeline execution | `@mendpoint/pipeline` (stages align to graph nodes) |

---

## Source

- [Graph Engineering vs Loop Engineering](https://www.aibuilderclub.com/blog/graph-engineering-vs-loop-engineering) — AI Builder Club  
- Internal: `docs/GRAPH_NATIVE.md`, `docs/ARCHITECTURE.md`, `docs/CALL_GRAPH.md`, `docs/EGRAPH.md`
