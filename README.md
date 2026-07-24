# Mendpoint

**Mendpoint** — structured API change intelligence → precise impact analysis → migration pull requests.

When an API provider ships a breaking change or a high-value capability, Mendpoint (with explicit customer permission) scans the relevant codebase and opens a PR. Customers review and merge. Providers reduce support load; enterprises get continuous API hygiene.

> Product: **Mendpoint**. Monorepo package root `mendpoint`, npm workspaces `@mendpoint/*`.

## Quickstart

```bash
git clone https://github.com/gondalaimafia/mendpoint.git
cd mendpoint
npm install
npm run db:seed
npm run demo          # OpenAPI diff → impact → mock PR (Acme fixture)
npm run examples      # Concrete migrations: Stripe, OpenAI, AWS S3, fintech, adoption
npm run phase-a:harness  # ≥70% TS impact recall on 3 samples
npm run phase-a          # REAL GitHub PR (requires gh auth)
npm run phase-c:python   # ≥70% Python impact recall
npm run phase-d:go       # ≥70% Go impact recall
npm run phase-e:java     # ≥70% Java impact recall
npm run phase-e:ruby     # ≥70% Ruby impact recall
npm run worker:poll      # poll local OpenAPI feeds once
npm run worker:jobs      # drain fan-out job queue
npm run eval:partners    # design-partner quality bar
npm run repair:test      # agentic repair layer
npm run agent:test       # Devin-style API bug agent
npm run agent:demo       # end-to-end API bug agent on fixture
npm test
npm run dev:api       # http://localhost:3001
npm run dev:web       # http://localhost:3000  · /agent · /repair · /graph
```




## What the demo does

1. Loads **Acme Payments** OpenAPI v1 → v2 (field rename, path removal, new balance endpoint).
2. Scans **shop-app** fixture (TypeScript + Python) for impacted call sites.
3. Generates a migration patch + PR body (risk, confidence, evidence).
4. Delivers via **mock GitHub** under `.mendpoint/mock-github/` (no network).
5. Persists change, findings, PRs, and audit events in SQLite (`data/mendpoint.sqlite`).

## Impact analysis architecture

Hybrid multi-stage (not whole-repo LLM, not pure static only):

1. **Change normalizer** → Impactable Surfaces (OpenAPI diff + severity + migration strategy)
2. **Codebase index** → imports, functions, API usages, approx. call graph (incremental)
3. **Candidate discovery** → high-recall deterministic filter (SDK / path / field / import)
4. **Context expansion** → enclosing function + callers + compact slice
5. **Deep confirmation** → static first, optional targeted LLM on slices
6. **Impact report** → brief for PR generation (sites, confidence, fix hints)

See `docs/ARCHITECTURE.md` for the full design and `docs/EXAMPLES.md` for concrete vendor migrations.


## Monorepo layout

| Path | Role |
|------|------|
| `packages/shared` | Domain types (surfaces, candidates, ImpactReport) |
| `packages/db` | SQLite control-plane schema/repos |
| `packages/change-intel` | OpenAPI diff → Impactable Surfaces |
| `packages/call-graph` | Hybrid call-graph, reverse reachability, **reset-recompute**, **persistent multi-version store** |
| `packages/egraph` | **E-graphs** / equality saturation for migration rewrite search |
| `packages/codebase-index` | Pre-computed code index (embeds call graph) |
| `packages/code-impact` | Candidates → graph expand → confirm → ImpactReport |
| `packages/generation` | Migration PR from impact brief + e-graph exploration notes |
| `packages/github` | Mock + real Octokit PR delivery |
| `packages/policy` | Path denylist, no auto-merge, auth review labels |
| `packages/catalog` | Vendor catalog + lockfile/import auto-detect + **feed poll** |
| `packages/pipeline` | Orchestrates full loop + policy + learning + audit |
| `packages/phase-a` | Real PR ship + TS/Python/Go quality harnesses |
| `apps/api` | Hono JSON API (webhooks, keys, feeds) |
| `apps/web` | Next.js provider/consumer/**feeds** dashboards |
| `apps/worker` | CLI `demo` / `watch` / **`poll`** |
| `fixtures/` | Acme + shop-app + **6 vendor examples** (incl. Go) |
| `packages/examples` | Runner for Stripe / OpenAI / AWS / fintech / adoption demos |



## Trust defaults

- `GITHUB_MODE=mock` by default — never requires GitHub credentials for local demos
- PR-only policy language in every generated PR body
- Low-confidence impacts are marked explicitly, not forced into “confident” PRs
- Audit log for every pipeline step
- Customer code is not used to train foundation models without explicit opt-in

Set `GITHUB_MODE=real` and `GITHUB_TOKEN` only when wiring the Octokit scaffold for live PRs.

## API surface (local)

- `GET /health`
- `GET /providers` · `POST /providers` · `GET /providers/:slug` · `PATCH /providers/:slug/feed`
- `POST /providers/:slug/versions` · `POST /providers/:slug/publish` · `publish-version`
- `GET /feeds` · `POST /feeds/poll`
- `POST /webhooks/github`
- `GET/POST /keys` · `POST /keys/:id/revoke`
- `GET /changes` · `GET /changes/:id`
- `GET /consumers` · `POST /consumers` · `POST /consumers/:id/monitor` · `detect`
- `GET /prs` · `GET /prs/:id` · `POST /prs/:id/feedback` · `POST /prs/:id/ci-check`
- `GET /audit` · `GET /metrics` · `GET /catalog`
- `GET /graph/changes/:id` · `GET /graph/product` · `GET /graph/api/:slug` · UI `/graph`

## Roadmap mapping (Months 0–3)

This scaffold is a **thin, working slice** of every major layer from the Months 0–3 plan:

- [x] GitHub delivery interface (mock + **real Octokit PR path**)
- [x] TypeScript + Python impact analysis
- [x] OpenAPI-driven breaking change detection
- [x] Basic PR generation
- [x] Dual dashboards + feedback loop fields
- [x] **Phase A:** harness ≥70% + real PR ship (`docs/PHASE_A.md`)
- [x] **Phase B:** LLM confirm (budgeted), TS compiler index, policy engine, metrics (`docs/PHASE_B.md`)
- [x] **Phase C:** provider publish UI, lockfile auto-detect, feedback learning, Python bar (`docs/PHASE_C.md`)
- [x] **Phase D:** continuous feed poll, GitHub webhooks, API keys, Go harness, CI check (`docs/PHASE_D.md`)
- [x] **Phase E:** GitHub App install wizard, tenants/plans stub, Java/Ruby bars, brand packs (`docs/PHASE_E.md`)
- [x] **Phase F:** Graph-native explorer + APIs (`docs/GRAPH_NATIVE.md`, `/graph`)
- [x] **Gap closure:** design-partner eval, GitHub App runtime, SDK feeds, severity, queue, notify-only, audit export (`docs/GAP_CLOSURE_PLAN.md`)
- [x] **Agentic repair layer:** diagnose → plan → apply → verify (`docs/AGENTIC_REPAIR.md`, `/repair`, `AGENTIC_REPAIR=1`)
- [x] **Welder** (API debug agent): trained on protocol/serialization/semantic/network/cascading/async/rate-limit failures (`docs/WELDER_TRAINING.md`, `/agent`, `@mendpoint/agent`)
- [ ] Real payment processor invoices (plan flip is stubbed)
- [ ] Enterprise SSO (SAML/OIDC)
- [ ] GitLab / Bitbucket / FedRAMP

See `docs/PRODUCT_SPEC.md` and `docs/ARCHITECTURE.md`.

## License

[MIT](./LICENSE)
