# Whole repository coherence debug log

Baseline: `f2da58b5e9376920a1ae8510adc3dfab52c38e7b`

## Confirmed symptoms

- Warden call graph construction crashes when a repository defines symbols named after object prototype properties such as `constructor`.
- Valid OIDC members authenticate but receive `403` on every protected route because human principals have no API key scopes.
- Several graph learning endpoints read or mutate the global graph without tenant scope.
- Graph learning SQLite connections fail immediately during overlapping API and worker writes because concurrency pragmas are absent.
- The production audit export link points to localhost instead of the authenticated same origin proxy.
- The production worker filters jobs and feed schedules to `tenant_default` and does not drain on termination.
- Feed content deduplication is global, so the first tenant suppresses later tenant pipelines.
- Web sessions share one production rate limit identity through the server proxy.
- Collection routes are unbounded and the consumer route performs an N plus one query.
- GitHub delivery has no request deadline and uploads every patch file concurrently.
- Review decisions can commit without their event and audit evidence.
- The pull request review screen hides structured verification evidence and permits approval without it.

## Root causes

- Attacker and repository controlled dictionary keys are stored in ordinary JavaScript objects.
- API key scope attenuation is incorrectly applied to OIDC human principals.
- Tenant scope is optional in graph helper APIs and omitted by individual routes.
- The graph database does not mirror the primary database WAL and busy timeout policy.
- A development URL escaped into a production page.
- Worker service lifecycle and tenant selection are environment fixed rather than queue driven.
- A provider content hash is incorrectly used as both source deduplication and tenant dispatch identity.
- Trusted proxy context lacks a privacy-preserving session fingerprint.
- Database query helpers lack response ceilings, composite indexes, and batched monitored API retrieval.
- Outbound delivery uses default client behavior with unlimited file fanout.
- Review writes span independent transactions.
- The structured review package is stored only inside freeform pull request text.

## Verification contract

- Add a failing regression for every code change before or with its fix.
- Dogfood Warden call graph indexing against this repository.
- Run focused suites, full tests, typecheck, production build, GA checks, specialist evals, dependency audit, and diff integrity.
- Merge only after protected CI, deploy exact main, then probe and browser verify production.

## Verified fixes

- Prototype-controlled symbol maps now use null-prototype records, including full and incremental regressions.
- Human OIDC sessions receive role-bound full scopes while API key scopes remain attenuated.
- Graph statistics, exports, embeddings, and experiments use tenant scope. Persistent graph storage uses WAL, normal synchronous mode, and a five second busy timeout.
- Feed source deduplication is shared while tenant dispatch claims and poll history are tenant-owned.
- Worker service claims all tenants, drains on termination, and runs two independently fenced job lanes.
- API collections have hard limits, required indexes, and batched relationship loading.
- SCM calls have fifteen second deadlines and patch files use concurrency eight.
- Reviews, domain events, and audits commit or roll back together.
- The review UI parses the immutable structured package and blocks approval when any required evidence section is missing.

## Local release evidence

- Full tests: pass.
- Full typecheck: pass.
- Production web build: pass, 21 pages, 103 kB shared first load JavaScript.
- GA check: pass, 84 requirements, 14 claims, graph benchmark 19 of 20.
- Specialist eval: 78 trials, pass at one 1.000, zero critical or deterministic failures.
- Production dependency audit: zero vulnerabilities.
- API startup: health 200 and readiness 200.
- Warden repository dogfood: 2,411 nodes and 7,605 edges.

## Follow-up remediation

- Persistent tenant graph queries now use read-only temporary SQLite views rather than copying the graph. Tenant ownership conflicts fail closed and edges require both scoped endpoints.
- Feed dispatch claims carry lease generations, so stale workers cannot complete a reclaimed dispatch. One source document fetch is shared across tenant schedules in a polling cycle.
- Global worker lanes permit at most one running claim per tenant, and the production lease is bounded to 30 seconds for deployment recovery.
- Provider, change, consumer, pull request, and audit lists use stable offset pages and advertise the next page.
- Shared catalog authority covers every provider mutation, including direct publish.
- Browser human review uses OIDC Authorization Code with PKCE. The access token is encrypted in an HttpOnly server session and only the proxy forwards it to API authentication. Preview sessions cannot submit decisions.
- Customer-ready startup fails unless browser OIDC and real GitHub delivery are configured. Private preview accurately reports unavailable human identity when it is absent.
- Follow-up independent audits found no remaining P0 or P1 repository-controlled defects.

## Final local evidence

- `npm test`: pass across all workspaces.
- `npm run typecheck`: pass across all workspaces.
- `npm run build`: pass, 21 generated pages and 103 kB shared first load JavaScript.
- `npm run ga:check`: pass, 84 requirements and 14 public claims; 41 verified, 40 partial, 2 scaffold, 1 blocked external.
- `npm run eval:agents`: 78 of 78 trials pass with zero critical or deterministic failures.
- `npm audit --omit=dev`: zero vulnerabilities.
- Docker build was not runnable because Docker is absent locally; protected CI must supply container evidence.
