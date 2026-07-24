# Pre-customer batch execution plan

> From `docs/PRE_CUSTOMER_BATCH_GAP_ANALYSIS.md`. Zero design-partner dependency.

**Goal:** Close the pre-customer batch so Warden is demoable, claim-safe, benchmarked internally, and shippable.

**Architecture:** Extend existing monorepo packages; no new cloud deps.

---

## Workstreams

| ID | Deliverable | Package/path |
|----|-------------|--------------|
| A1 | Auto-merge hard-off (`ALLOW_AUTO_MERGE`) | `policy` |
| A2 | Exposure report v0 (JSON/MD) | `db` metrics + API + optional package |
| A3 | Flagship OpenAPI fixture pack (5 vendors) | `fixtures/providers/*` |
| A4 | GitHub Checks comment polish (Warden) | `github/checks.ts` |
| B1 | Changelog deprecation parser | `catalog/changelog-parse.ts` |
| B2 | warden-bench v0 (≥5 cases) | `fixtures/warden-bench` + `eval` |
| B3 | Slack webhook notify | `packages/notify` or `shared` + API |
| B4 | Verify command discovery | `agent` or `shared` |
| C1 | Docs: DESIGN_PARTNER_PATH, claims link, demos matrix | `docs/*` |
| Ship | `npm test`, commit, push `main` |

---

## Acceptance

- [ ] `npm test` green  
- [ ] Exposure: `GET /consumers/:id/exposure` returns deps + findings summary  
- [ ] Flagship fixtures exist for stripe, openai, twilio, aws-s3, plaid  
- [ ] Changelog parser tests pass  
- [ ] `npm run eval:warden` runs ≥5 cases  
- [ ] Slack: dry-run or webhook when `SLACK_WEBHOOK_URL` set  
- [ ] Policy: auto-merge impossible unless `ALLOW_AUTO_MERGE=1`  
- [ ] Pushed to GitHub  

---
