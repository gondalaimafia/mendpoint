# Mendpoint

**Fettler — the first AI API Engineer** is Mendpoint's API integration teammate, available as a **Private Design Partner Preview** for approved pilot teams. Its companion **ReGauge — the first AI Legacy Engineer** takes on legacy and multi-repo migration campaigns as an experimental planning preview. Mendpoint follows a **graph engineering** approach: specialized loop-nodes (change intel → call-graph expand → generate → verify → human review), not one overloaded agent. **It never auto-merges by default** — any delivered change lands as a reviewable pull request that a person approves and merges.

For submitted OpenAPI changes, Mendpoint can analyze configured repository snapshots and generate evidence-backed migration pull request candidates for supported GitHub repositories. Customers review and merge.

> Platform: **Mendpoint**. Products: **Fettler (Private Design Partner Preview)** and **ReGauge (experimental planning preview)**. Production runbook: [`docs/PRODUCTION_GA.md`](./docs/PRODUCTION_GA.md). Claim-safe language: [`docs/WARDEN_CLAIMS.md`](./docs/WARDEN_CLAIMS.md). Doctrine: [`docs/GRAPH_ENGINEERING.md`](./docs/GRAPH_ENGINEERING.md).

## How it works

Mendpoint runs a migration as a graph of specialized nodes, each with a narrow job, rather than one prompt doing everything:

1. **Change intel** — normalize a submitted OpenAPI change into impactable surfaces (diff, severity, migration strategy).
2. **Call-graph impact** — expand from candidate call sites through the hybrid call graph to enclosing functions and callers, using static, graph-backed, and heuristic evidence.
3. **Generate** — produce a proposed patch and PR body for supported migration patterns, with the evidence and confidence attached.
4. **Verify** — run the configured verification checks before a draft PR is eligible for delivery. Low-confidence impacts are marked explicitly, not forced into confident-looking PRs.
5. **Human review** — deliver a reviewable pull request. **Mendpoint does not merge it.** Review and merge stay in the customer's source control.

See [`docs/GRAPH_ENGINEERING.md`](./docs/GRAPH_ENGINEERING.md) for the doctrine and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full impact-analysis design.

## Pilot quickstart (self-hosted)

The Fettler preview supports approved pilot evaluation on a single-node self-hosted control plane.

```bash
git clone https://github.com/gondalaimafia/mendpoint.git
cd mendpoint
npm install
npm run db:seed

export NODE_ENV=production API_AUTH=required
npm run ga:check                 # production GA preflight
docker compose up --build        # API on :3001, web on :3000
# or run the API directly:
npm run start:api
```

In production (`NODE_ENV=production`) the API requires authentication, enforces rate limits, and exposes readiness and liveness probes for orchestration. See [`docs/PRODUCTION_GA.md`](./docs/PRODUCTION_GA.md) for the full runbook.

## Products

### Fettler — AI API Engineer (Private Design Partner Preview)

Fettler turns submitted OpenAPI changes into graph-backed impact analysis and proposed patches for supported migration patterns on configured GitHub repositories. It also runs an on-demand API debug loop — a goal-driven, bounded multi-step tool loop for protocol, serialization, semantic, network, and rate-limit failures. Access is limited to approved private pilot teams.

### ReGauge — AI Legacy Engineer (preview)

ReGauge extends the same graph-engineering approach to legacy and multi-repo migration campaigns, planning dependency-aware staged work across repositories. It is an experimental planning preview: repository execution and staged pull-request campaigns are not customer-ready yet.

## Try it offline

The bundled demo and examples run fully offline against fixtures — no GitHub credentials and no network. Delivery halts at the same policy gates as production (fail-closed).

```bash
npm run demo         # Acme OpenAPI v1 to v2 diff → impact → PR candidate (mock GitHub)
npm run examples     # Stripe, OpenAI, AWS S3, fintech, multi-language fixtures
npm run agent:demo   # Fettler on-demand API debug loop
npm test             # full test suite
npm run dev:api      # local API at http://localhost:3001/status
npm run dev:web      # local dashboards at http://localhost:3000
```

The demo loads an Acme Payments OpenAPI v1 to v2 change (field rename, path removal, new endpoint), scans a TypeScript + Python fixture for impacted call sites, generates a migration patch and PR body, and delivers it through a mock GitHub under `.mendpoint/mock-github/` — no network. See [`docs/EXAMPLES.md`](./docs/EXAMPLES.md) for concrete vendor migrations.

## Trust defaults

- **Never auto-merges by default** — human review is required; there is no auto-merge without an explicit, experimental policy.
- `GITHUB_MODE=mock` by default — local demos never require GitHub credentials.
- PR-only policy language is stamped into every generated PR body.
- Low-confidence impacts are marked explicitly, not presented as confident.
- Every pipeline step is written to an audit log.
- Customer code is not used to train foundation models without explicit opt-in.

Customer deployments use `GITHUB_MODE=real` with GitHub App credentials scoped to approved repositories.

## Repository layout

| Path | Role |
|------|------|
| `packages/change-intel` | OpenAPI diff → impactable surfaces |
| `packages/call-graph` | Hybrid call graph, reverse reachability, persistent multi-version store |
| `packages/code-impact` | Candidates → graph expand → confirm → impact report |
| `packages/generation` | Migration PR from the impact brief |
| `packages/agent` | **Fettler** — on-demand API debug loop-node |
| `packages/transformer` | **ReGauge** — campaign planning types (preview) |
| `packages/orchestrator` · `packages/graph` | Graph-engineering topology, routing, shared state |
| `packages/pipeline` · `packages/policy` | Product stages + audit; path denylist, no-auto-merge, review labels |
| `packages/github` | Mock + real Octokit PR delivery |
| `apps/api` · `apps/web` · `apps/worker` | JSON API, dashboards, and the demo / watch / poll CLI |

See [`docs/PRODUCT_SPEC.md`](./docs/PRODUCT_SPEC.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and [`docs/WARDEN_CLAIMS.md`](./docs/WARDEN_CLAIMS.md) for the full design and claim-safe public language.

## License

[MIT](./LICENSE)
