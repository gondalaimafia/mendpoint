<!-- CURSOR_AGENT_PR_BODY_BEGIN -->
## Objective

Wave 0 of Completion Assurance: record repository truth and the sequenced build program before any schema or callers. No GitHub issue was opened — this agent’s `gh` client is read-only.

## Author

- [x] Cursor Agent
- [ ] Claude Code
- [ ] OpenAI Codex
- [ ] Human

## What changed

Added `docs/completion-assurance/`:

- `CURRENT_STATE.md` — archaeology against `origin/main` `da3ba22`. Every Completion Assurance spec requirement classified SATISFIED / PARTIAL / MISSING / CONFLICTING / DEFERRED with `path:line` evidence.
- `IMPLEMENTATION_PLAN.md` — Phases 0–5 / A–J, validator wall, gate binding only in Phase 5, PR DAG, open product decisions, truth boundary.
- `README.md` — index. Later spec docs (ARCHITECTURE, VALIDATOR_WALL, …) are filled in the matching wave.

No TypeScript, no schema, no Mission transition, no `package.json`.

## Why

The Completion Assurance spec requires CURRENT_STATE + IMPLEMENTATION_PLAN before architecture. Main has Mission Space persistence and no independent definition of done. Building schema first would invent a duplicate of verification standing, artifacts, and policy.

## Scope

- `docs/completion-assurance/*` only

## Product impact

- [ ] Fettler
- [ ] ReGauge
- [x] Shared platform (docs only — no behavior change)
- [ ] Change Graph
- [ ] Model router
- [ ] Learning system
- [ ] Infrastructure
- [x] No product behavior change

## Architecture impact

- [x] No architecture change (plan + archaeology only)
- [ ] Existing ADR applies
- [ ] New ADR added (Wave 0b, next)
- [ ] Human architecture review required

## Verification

```text
22 / 23 path:line citations in CURRENT_STATE.md resolved as originally authored.
The 23rd was wrong: LESSON_DESTINATION_DISPOSITIONS was cited at
lesson-routing.ts:8-16; it is at :81 (8-16 is an unrelated comment paragraph).
Corrected in this revision, so 23 / 23 now resolve on da3ba22.
Zero matches for CompletionStandard | CompletionGate | RemediationDirective outside docs/completion-assurance/
git diff --stat: 3 files, docs only
```

## Regression coverage

Docs-only. Citation check is the regression: a moved line on main must be re-verified before Wave A.

## Security / governance

No auth, tenant, secret, or runtime change. The plan treats the validator wall as a later high-risk auth wave and forbids hidden-case leakage.

## Rollback

Revert this PR. Unused documentation directory.

## Known risks

- `docs/missions/CURRENT_STATE.md` is stale relative to live `transitionMission` at ReGauge launch; this document cites code, not that file.
- Fifteen open product decisions are listed, not decided.
- Open collision files (#516, #533, #542, #543, #499) remain do-not-edit for later waves.

## Review fixes applied (2026-08-31)

Six defects found in review, all fixed in this revision.

1. **A Part E row was false at authoring time.** `| docs/missions/V4_GAP_ANALYSIS.md | Open #445 |` was wrong in both halves: #445 is CLOSED (never merged), and that file has never existed on main — `git ls-tree origin/main docs/missions/` returns only `CONTEXT_COMPILER.md`, `CURRENT_STATE.md`, `TASK_HANDOFFS.md`. The row was authored from PR metadata rather than from the tree, which matters for a document whose thesis is "believe the code cited here." Row removed. The other seven Part E rows were re-checked against live GitHub and all still hold (#516, #499, #533, #543, #542, #526, #461 OPEN; #523, #524 MERGED).
2. **Wrong citation line**, and the self-check above was consequently false. Both corrected.
3. **Part C is keyed to a document that is not in this repository.** `git grep -il "Completion Assurance"` on `origin/main` returns zero files, so no reader here can check what any `§` requires. The spec could not be obtained, so Part C is now explicitly marked unauditable rather than leaving it implied. Vendoring it into `docs/completion-assurance/SPEC.md` is the real fix and is owed before Wave A.
4. **The document omitted its own strongest evidence.** Finding 4 now cites `packages/pipeline/src/lesson-routing.ts:37-38` and `:234-237`, where main already records that both production producers feed the attribution deriver a constant `not_verified` because Warden's independent verifier is unsatisfiable and ReGauge's `passed` flag is tautological with no verifier. An already-merged in-repo finding that the existing "verification passed" signal is tautological is stronger than anything Part B cited.
5. **Stale pin refreshed** to `da3ba22` — see the caveat below.
6. **No automated check guards these citations.** `scripts/evidence-reachability-check.ts` walks `docs/PRODUCT_REQUIREMENTS.json` and `apps/web/app/docs/catalog.ts` only, not `docs/**/*.md`. Extending it is not a small change (1005 lines, built around the requirements register), so this is recorded as an explicit warning in README.md instead.

## The pin refresh held by hunk placement, not by the files being static

The claim that no citation drifted between `d232a27` and `da3ba22` was re-tested rather than trusted, and it was not quite right. Two cited files **did** change between those commits: `apps/worker/src/cli.ts` (cited without a line number, so unaffected) and `packages/db/src/index.ts`, which carries three line-range citations — `:118-136`, `:681-711`, `:1047-1065`.

Those three survived only because every insertion in that diff lands at line 2292 or later, after all three ranges. The content at each range was then confirmed directly. So the refreshed pin is correct, but it held by where the hunks happened to fall, not because the cited files were static.

Two consequences the next reader should not have to rediscover:

- **This is not self-maintaining.** Combined with fix 6 — no gate reads `docs/completion-assurance/` — a future pin refresh can silently break citations if a hunk lands above a cited range. Re-verify by diffing the old and new pins for cited files, not by assuming stability.
- **The drift is inherent.** Main moved again during this fix round (`da3ba22` is already not the tip). That was deliberately not chased: a document pinned to a moving branch is stale the moment it merges. The pin records the commit the archaeology was actually verified against, which is the only claim it can honestly make.

## Peer reviewer

- Cursor author → Claude (`@claude review`)

## Review state

- [x] Peer review requested
- [ ] Peer review complete
- [ ] P0/P1 findings resolved
- [ ] P2 findings resolved or explicitly accepted/escalated
- [ ] CI green
- [ ] Ready for human merge

<!-- CURSOR_AGENT_PR_BODY_END -->

<div><a href="https://cursor.com/agents/bc-cb00ef15-0416-4c9f-97b0-88119cb0f457?cursor_ref=pr_footer&cursor_cta=open_in_web"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-web-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-web-light.png"><img alt="Open in Web" width="114" height="28" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a>&nbsp;<a href="https://cursor.com/background-agent?bcId=bc-cb00ef15-0416-4c9f-97b0-88119cb0f457&cursor_ref=pr_footer&cursor_cta=open_in_cursor"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/open-in-cursor-dark.png"><source media="(prefers-color-scheme: light)" srcset="https://cursor.com/assets/images/open-in-cursor-light.png"><img alt="Open in Cursor" width="131" height="28" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a>&nbsp;</div>


