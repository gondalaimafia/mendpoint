# Phase C — Spec MVP completeness

Phase C closes the remaining product-shaped MVP gaps after Phase A (real PR) and Phase B (trust + metrics).

## Delivered

| Item | Implementation |
|------|----------------|
| **Provider publish UI** | `/provider` form → `POST /providers/:slug/publish-version` (OpenAPI JSON + changelog + optional pipeline) |
| **OpenAPI upload API** | Existing versions route + combined publish-version |
| **Vendor catalog** | `@mendpoint/catalog` — stripe, openai, aws-sdk, acme, payments-api, twilio, github |
| **Auto-detect APIs** | Lockfiles + imports → `POST /consumers/:id/detect` + Consumer UI button |
| **Feedback learning** | Closed PRs → `suppressed_patterns` table; future impact filters matching symbols |
| **Python quality bar** | `npm run phase-c:python` — ≥70% expected-site recall on OpenAI Python fixture |
| **Learning visibility** | `GET /learning/suppressed` + Consumer console list |

## Commands

```bash
npm run db:seed
npm run dev:api
npm run dev:web

# Provider: open /provider → paste OpenAPI JSON → Publish
# Consumer: open /consumer → Auto-detect APIs

npm run phase-c:python    # Python harness
npm run phase-a:harness   # TypeScript harness (still)
npm test -w @mendpoint/catalog -w @mendpoint/pipeline
```

## Learning loop

1. Human marks PR **closed** (not merged) in dashboard or API.  
2. `applyPrFeedback` extracts symbols from PR body.  
3. Patterns stored in `suppressed_patterns`.  
4. Next `runChangePipeline` / impact pass skips matching findings for that consumer.

## Not in Phase C (→ Phase D)

- Continuous polling of OpenAPI feeds → see `docs/PHASE_D.md`  
- GitHub webhooks + App manifest → Phase D  
- Light multi-tenant API keys → Phase D  
- Go quality bar → Phase D  
- Still later: full OAuth wizard UI, billing/SSO, Java/Ruby bars

## Success criteria

- [x] Vendor can upload OpenAPI from UI without CLI  
- [x] Consumer can auto-link known vendors from package.json / requirements  
- [x] Closing a PR teaches suppression  
- [x] Python impact recall ≥70% on fixture  
