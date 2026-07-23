# Phase A — Thin vertical slice on real repos

**Goal:** One real GitHub install path → one structured API change → high-confidence PR on a real repo.

## What Phase A delivers

| Requirement | Implementation |
|-------------|----------------|
| Real PR delivery | `OctokitGitHubDelivery` (`@mendpoint/github`) via `GITHUB_TOKEN` or `gh auth token` |
| Design-partner change type | Acme Payments **field rename** `amount_cents` → `amount` (+ receipt removal flag) |
| TypeScript focus | Phase A consumer + harness on 3 TS samples |
| ≥70% expected-site recall | `npm run phase-a:harness` |
| Dashboard | Existing `/consumer` PR list; real `githubPrUrl` written to SQLite |

## Commands

```bash
# Quality bar only
npm run phase-a:harness

# Full ship: harness → sandbox repo → REAL PR
npm run phase-a
```

Requires: `gh auth login` with `repo` scope (or `GITHUB_TOKEN`).

## Sandbox repo

Default: `https://github.com/<you>/mendpoint-phase-a-sandbox`

- Public repo created if missing
- Baseline commit with **legacy** consumer code
- Agent opens branch `mendpoint/phase-a-*` and a PR (never direct push of migration to default branch as the final state — migration lands via PR)

Override:

```bash
$env:PHASE_A_REPO="my-sandbox"
$env:PHASE_A_BASE="main"
npm run phase-a
```

## Design-partner path (next human step)

1. Fork or point `PHASE_A_REPO` at a real product repo (TypeScript).
2. Ensure legacy patterns exist (or use a known OpenAPI breaking change for a dependency they use).
3. Run `npm run phase-a` (or wire publish webhook later).
4. Engineer reviews PR → merge → record feedback in dashboard.

## Success criteria (Phase A)

- [x] Real Octokit create branch / commit / open PR
- [x] Harness ≥70% recall on three TS consumers
- [x] One-command ship path
- [ ] At least one PR **merged** by a human on a non-sandbox repo (your action)
- [ ] Second successful ship without fixture-only consumer (your action)

## Artifacts

- `.mendpoint/phase-a/last-ship.json` — PR URL, harness scores
- `.mendpoint/phase-a/pr-body.md`
- SQLite `migration_prs` row with real `github_pr_url`
