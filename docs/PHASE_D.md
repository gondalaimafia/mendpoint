# Mendpoint Phase D — Continuous ops & light multi-tenant

Phase D closes the remaining high-leverage product gaps after Phases A–C: continuous change feeds, GitHub webhook path, API keys, Go quality bar, and CI-check comments.

## Delivered

| Item | Implementation |
|------|----------------|
| **Continuous OpenAPI poll** | `packages/catalog` poll + `worker poll` / `poll-once` / `POST /feeds/poll` |
| **Catalog feed URLs** | `openapiUrl` / `changelogUrl` on vendors; DB `providers.openapi_url`; acme uses local `file:` fixture |
| **Feed ledger** | `feed_polls` table + `GET /feeds` |
| **GitHub webhooks** | `POST /webhooks/github` — HMAC verify, installation + PR closed/merged → feedback |
| **GitHub App manifest** | `docs/github-app-manifest.json` + install notes below |
| **API keys** | `api_keys` (hashed), `POST/GET /keys`, `API_AUTH=off\|auto\|required` |
| **Go harness** | `npm run phase-d:go` — fixture `fixtures/examples/06-go-stripe` ≥70% recall |
| **CI check comment** | `formatCiCheckComment` + `POST /prs/:id/ci-check` |
| **Feeds UI** | `/feeds` dashboard page |

## Commands

```bash
npm run db:seed
npm run dev:api
npm run dev:web

# Continuous feed (local fixtures only)
npm run worker -- poll-once --local
npm run worker -- poll --local --interval 60000

# List feeds + recent polls
npm run worker -- feeds

# Go quality bar
npm run phase-d:go

# Optional: require API keys
# API_AUTH=required  then POST /keys  → use Authorization: Bearer me_...
```

## Poll loop

1. Collect feeds from catalog (`openapiUrl`) + provider DB overrides.  
2. Fetch JSON OpenAPI (`file:` or `https:`).  
3. Content-hash; if new → `insertApiVersion` + optional `runChangePipeline`.  
4. Record `feed_polls` row (`unchanged` | `new_version` | `pipeline_ran` | `error`).

Acme default URL: `file:fixtures/providers/acme-payments/openapi-v2.json` (offline-safe).

Override live vendors:

```bash
set STRIPE_OPENAPI_URL=https://...
set OPENAI_OPENAPI_URL=https://...
```

Or `PATCH /providers/:slug/feed` with `{ "openapiUrl": "..." }`.

## GitHub App install (manual)

1. Create a GitHub App from `docs/github-app-manifest.json` (or paste permissions/events).  
2. Set **Webhook URL** → `https://YOUR_HOST/webhooks/github`.  
3. Set **Webhook secret** → export `GITHUB_WEBHOOK_SECRET`.  
4. Install on consumer orgs/repos.  
5. On `installation` events, matching consumers (by `github_owner`) get `installation_id`.  
6. On PR `closed`/`merged`, matching migration PRs receive feedback (learning loop).

PAT path from Phase A still works (`GITHUB_MODE=real` + `GITHUB_TOKEN`). Full OAuth install wizard is out of scope.

## Auth model

| `API_AUTH` | Behavior |
|------------|----------|
| `off` (default) | Open — local/dev |
| `auto` | Require key only when ≥1 active key exists |
| `required` | Always require `Authorization: Bearer me_...` or `X-API-Key` |

Exempt: `/health`, `/webhooks/*`.

Keys are stored as SHA-256 hashes; plaintext returned **once** at create.

## CI check on PRs

```http
POST /prs/:id/ci-check
{ "harness": [...], "post": false }
```

Returns markdown body for advisory PR comment (never auto-merge). With real GitHub, wire `OctokitPrCommenter` + `GITHUB_MODE=real`.

## Success criteria

- [x] Worker can poll local OpenAPI feeds and record ledger  
- [x] Webhook endpoint verifies signature and applies PR feedback  
- [x] API keys create/list/revoke + middleware  
- [x] Go harness ≥70% on fixture  
- [x] CI check comment formatter + API  
- [x] Docs + feeds UI  

## Explicitly not in Phase D

- Billing / plans / SSO  
- Full GitHub App OAuth wizard UI  
- FedRAMP / enterprise multi-region  
- Java/Ruby harnesses  
- Auto-merge (forbidden by product policy)
