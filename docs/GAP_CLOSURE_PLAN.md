# Gap closure build plan

## Goal

Close every gap from the vision gap analysis that can ship inside this monorepo with tests. Hosted Postgres/Stripe SSO remain adapters/stubs where credentials are external.

## Workstreams

### P0 — Proof & runtime
1. **Design-partner eval suite** (`@mendpoint/eval`) — multi-repo fixtures, precision/recall, merge-ready score, `npm run eval:partners`
2. **GitHub App runtime** — App JWT, installation access tokens, multi-repo delivery, uninstall webhook handling
3. **Live vendor feed path** — feed runner with SDK registry signals (npm/pypi version probes) + durable poll ledger

### P1 — PR quality & provider GTM
4. **Stronger migrations** — multi-file coordinated renames, adopt-mode PRs, optional CI-loop scaffold (check → comment → re-run)
5. **Provider portal severity** — `required | recommended | optional` on changes; pipeline respects severity

### P2 — Ops & enterprise wedge
6. **Job queue** — SQLite-backed queue for fan-out (one change → N consumers)
7. **Notification-only mode** — policy flag: findings + audit, no PR
8. **Audit export** — JSON/CSV for compliance
9. **Design-partner metrics** — time-to-merge, open rate, suppress rate, coverage

## Success criteria
- [x] `npm run eval:partners` exits 0 with documented thresholds (**100% overall on 5 partners**)
- [x] GitHub App delivery unit-tested (JWT RS256 + multi-repo mock delivery)
- [x] Feed + SDK signal tests pass (`probeKnownSdks({ localOnly: true })`)
- [x] Pipeline supports notification-only + severity (`required|recommended|optional`)
- [x] Audit export + design-partner metrics API
- [x] Queue processes fan-out jobs in worker (`worker process-jobs`)

## Commands

```bash
npm run eval:partners
npm run worker:jobs
npm test -w @mendpoint/github -w @mendpoint/ci-loop -w @mendpoint/eval
# API
# GET /metrics/design-partner
# GET /audit/export?format=json|csv
# POST /changes/:id/severity { "severity": "required" }
# POST /jobs/fanout { "providerSlug": "acme-payments" }
# GET /feeds/sdk-signals?local=1
```

## Still external (cannot fully ship in monorepo alone)
- Live Stripe invoices / real SSO IdP
- Production GitHub App private key in secrets store
- Multi-region Postgres HA
