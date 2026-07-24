# warden-bench — internal eval notes

**Date:** 2026-07-23  
**Status:** v0 internal only  
**Not for marketing, sales decks, or public “vs general agents” claims.**

Public claim-safe language: [`WARDEN_CLAIMS.md`](./WARDEN_CLAIMS.md).  
Fixture pack: [`fixtures/warden-bench/`](../fixtures/warden-bench/).

---

## How to run

```bash
# from monorepo root
npm run eval:warden

# or via package tests (includes ≥5 cases, ≥1 pass assertion)
npm test -w @mendpoint/eval
```

Each case copies `repo/` to a temp directory, runs:

```ts
runWarden({
  goal: /* issue.md text only */,
  repoRoot: tempDir,
  verifyCommand: meta.verify, // usually "node check.mjs"
})
```

Pass = verify command exits 0 after the agent run.

---

## Corpus (v0)

| Case | Class | Verify |
|------|--------|--------|
| `01-path-typo` | Wrong path (`chargess`) | `node check.mjs` |
| `02-amount-field` | Field rename `amount_cents` → `amount` | `node check.mjs` |
| `03-max-tokens` | `max_tokens` → `max_completion_tokens` | `node check.mjs` |
| `04-https-upgrade` | `http://api.` → `https` (SSL goal) | `node check.mjs` |
| `05-idempotency` | POST + double-charge → `Idempotency-Key` | `node check.mjs` |

---

## Baseline expectation

| Metric | Gate |
|--------|------|
| Total cases | ≥ 5 |
| Passed unassisted (heuristics, no LLM) | ≥ 1 |
| Network | not required |
| Issue text | no file paths |

**Baseline recorded 2026-07-23:** 5/5 cases passed on heuristics (no LLM).

Re-run after agent changes and update this file with the date and pass count when you publish internal numbers to the team. Do **not** put pass rates in external copy until a reviewed public API-bench exists.

---

## Explicit non-claims

- Not a competitive leaderboard  
- Not statistically significant  
- Not customer-production issues (synthetic fixtures)  
- Not a substitute for design-partner eval (`npm run eval:partners`)
