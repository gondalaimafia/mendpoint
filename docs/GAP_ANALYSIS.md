# Mendpoint — Gap analysis vs product vision

Vision: API providers should not only announce changes — they should **apply** them as reviewable PRs in customer codebases (per-vendor agents or neutral multi-vendor platform).

| Area | Maturity (0–5) | Status after gap-closure build |
|------|----------------|--------------------------------|
| Core loop (change → impact → PR) | 4 | Strengthened |
| Live change feeds | 2→3+ | Live feed path + SDK signals |
| Impact quality / eval | 3→4 | Design-partner eval suite |
| Migration correctness | 2→3 | Multi-file + adopt mode + CI loop scaffold |
| GitHub App runtime | 2→4 | JWT / installation tokens / multi-repo |
| Branded agents | 2→3 | Severity + brand packs |
| Multi-tenant ops | 1→3 | SQLite job queue + export |
| Enterprise trust | 3→4 | Notification-only + audit export |
| Billing / SSO / multi-SCM | 1 | Stub remains (out of local monorepo scope for real processors) |

See `GAP_CLOSURE_PLAN.md` for the implementation program.
