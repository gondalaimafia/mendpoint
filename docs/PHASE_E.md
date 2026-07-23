# Mendpoint Phase E — Remaining product surface

Phase E finishes the Months 0–3 roadmap items left after D: GitHub App install wizard, multi-tenant plans, Java/Ruby quality bars, and first-party branded packaging.

## Delivered

| Item | Implementation |
|------|----------------|
| **GitHub App install wizard** | `GET /github/app/*`, mock install callback, UI `/install` |
| **Installations ledger** | `github_installations` table; links consumers by owner login |
| **Multi-tenant workspaces** | `tenants` + default workspace; `tenant_id` on consumers/API keys |
| **Billing plans (stub)** | Free / Pro / Enterprise — `GET /billing/plans`, `POST /tenants/:id/plan`, UI `/billing` |
| **Java harness** | `npm run phase-e:java` — fixture `07-java-stripe` ≥70% |
| **Ruby harness** | `npm run phase-e:ruby` — fixture `08-ruby-stripe` ≥70% |
| **Indexer** | `.java` / `.rb` / `.kt` / `.go` in codebase index |
| **First-party brands** | `@mendpoint/branding` packs; `GET /brands`; pipeline `brandPackId` / `BRAND_PACK` |
| **Brand UI** | `/brands` with PR packaging preview |

## Commands

```bash
npm run db:seed
npm run dev:api
npm run dev:web

# Quality bars
npm run phase-e:java
npm run phase-e:ruby
npm run phase-d:go
npm run phase-c:python
npm run phase-a:harness

# Mock GitHub App install
curl -s http://localhost:3001/github/app/config
curl -s -X POST http://localhost:3001/github/app/callback \
  -H "content-type: application/json" \
  -d "{\"accountLogin\":\"demo-org\",\"tenantId\":\"tenant_default\"}"

# Brand preview
curl -s -X POST http://localhost:3001/brands/acme-payments-agent/preview \
  -H "content-type: application/json" -d "{}"

# Plan change (no charge)
curl -s -X POST http://localhost:3001/tenants/tenant_default/plan \
  -H "content-type: application/json" -d "{\"plan\":\"pro\"}"
```

## Real GitHub App

1. Create app from `docs/github-app-manifest.json`.  
2. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`.  
3. `mockMode` becomes false; install URL points at `github.com/apps/{slug}/installations/new`.  
4. After install, GitHub hits webhook + your setup URL; call `POST /github/app/callback` with installation payload (or map from webhook `installation` event — already recorded in D).

## Brand packaging in pipeline

```bash
# Auto-select pack by provider slug
set BRAND_PACK=auto
# or explicit
set BRAND_PACK=stripe-update-agent
```

Or `runChangePipeline({ brandPackId: true | "acme-payments-agent", ... })`.

## Explicitly still later

- Real Stripe/billing provider charges & invoices  
- Enterprise SSO (SAML/OIDC)  
- FedRAMP / multi-region  
- GitLab / Bitbucket  
- Auto-merge (forbidden)

## Success criteria

- [x] Install wizard works in mock mode end-to-end  
- [x] Tenants + plan stub UI  
- [x] Java + Ruby ≥70% harnesses  
- [x] Brand packs list + PR preview + pipeline wire  
- [x] Docs + nav
