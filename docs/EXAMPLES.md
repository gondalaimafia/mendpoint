# Concrete API Migration Examples

These fixtures prove the full loop the architecture is designed to deliver:

1. **Structured change event** (provider / platform publishes)  
2. **Impact analysis** (call graph + static confirmation + confidence)  
3. **Context** (wrappers, tests, shared clients)  
4. **PR generation** (edits + body + optional e-graph rewrite notes)

Run:

```bash
npm run examples           # all
npm run examples -- 01     # filter by folder prefix
npm test -w @mendpoint/examples
```

Artifacts land in `.mendpoint/example-runs/<id>/` (`pr.md`, `patch.diff`, `impact.json`, `migrated/`).

---

## Example 1 — Stripe pagination (offset → cursor / auto-paging)

| | |
|--|--|
| **Folder** | `fixtures/examples/01-stripe-pagination` |
| **Vendor** | stripe |
| **Type** | breaking + recommended |
| **Surface** | `GET /v1/customers` / `stripe.customers.list` |

**Before:** manual `starting_after` loops in `syncCustomers.ts` + test mocks.  
**Impact:** direct list call, wrapper `fetchAllCustomers`, test file — high confidence (SDK method + param).  
**PR:** migrates toward `autoPagingToArray` / cursor helpers; links Stripe pagination docs.

## Example 2 — OpenAI chat parameter + response shape

| | |
|--|--|
| **Folder** | `fixtures/examples/02-openai-chat` |
| **Vendor** | openai |
| **Type** | breaking |
| **Surface** | `chat.completions.create` |

**Before (Python):** `max_tokens=…` and `choices[0].text` in `llm_client.py` / `batch_jobs.py`.  
**Partial migration:** `already_migrated()` already uses `max_completion_tokens`.  
**Impact:** multi-file sites + shared `ask_llm` helper.  
**PR:** rename param, switch to `message.content`, leave already-correct sites intact.

## Example 3 — AWS S3 SDK v2 → v3 modular

| | |
|--|--|
| **Folder** | `fixtures/examples/03-aws-s3-v3` |
| **Vendor** | aws-sdk |
| **Type** | breaking (major) |
| **Surface** | `AWS.S3` / `getObject` |

**Before:** monolithic `aws-sdk`, `.promise()`, `Body.toString()`.  
**Impact:** all `AWS.S3` constructions + `getObject` + Body assumptions.  
**PR:** `@aws-sdk/client-s3`, `GetObjectCommand`, `streamToString` helper.

## Example 4 — Internal fintech transfers

| | |
|--|--|
| **Folder** | `fixtures/examples/04-fintech-transfers` |
| **Vendor** | payments-api |
| **Type** | breaking |
| **Surface** | `POST /v2/transfers` |

**Before:** `X-API-Key` header, no `idempotency_key`.  
**Impact:** shared `apiClient` factory + direct fetch sites.  
**PR:** Bearer auth, `crypto.randomUUID()` idempotency keys, comments.

## Example 5 — Feature adoption (non-breaking)

| | |
|--|--|
| **Folder** | `fixtures/examples/05-stripe-feature-adoption` |
| **Vendor** | stripe |
| **Type** | new_capability (optional) |
| **Surface** | auto-paging helper |

**Before:** manual `has_more` loop.  
**PR label:** optional improvement — adopt official auto-paging helper.

---

## Mapping to architecture

| Pipeline stage | What the examples exercise |
|----------------|----------------------------|
| Change intelligence | `change-event.json` → surfaces/diff (`surfaces.ts`) |
| Codebase index + call graph | `analyzeImpact` on each consumer tree |
| Candidate discovery | SDK tokens, HTTP paths, field names |
| Confirmation | confidence scores in `impact.json` |
| E-graph | field renames / pagination rewrite notes in PR body |
| Generation | `pr.md` + `patch.diff` + `migrated/` tree |

These examples are the acceptance narrative for Mendpoint: **announce → locate → rewrite → human review**.
