# Learning Flywheel Parallel Work Notes

Updated: 2026-08-14

Controlling specification: `Codex Master Prompt — Build and Ship the Mendpoint Learning Flywheel.md`. It supersedes the earlier attached flywheel brief.

## Codex ownership

- Branch: `codex/learning-loop-production`
- Starting commit: `1f83b4a`
- Base: current `origin/main` at branch creation
- Worktree: `mendpoint-rename-review-main`

Codex owns the learning flywheel integration:

- common learning event contracts
- Fettler and ReGauge outcome admission joins
- dataset sealing and corpus materialization
- training orchestration and authenticated trainer reconciliation
- adapter lifecycle, router admission, canary, monitoring, and rollback joins
- learning API and operator documentation
- end to end learning flywheel tests

Expected working areas:

- `packages/db/src/learning*`
- `packages/pipeline/src/learning*` and post trained modules
- `packages/platform/src/adapter-lifecycle.ts`, post trained runtime, and router integration
- `apps/api/src/advanced-ai-applications*`
- narrowly scoped Fettler and ReGauge outcome producer call sites in `apps/worker/src`
- `docs/learning/` and the post trained public documentation entry
- deployment configuration only after the full fail closed path is green

## Claude Code ownership and intentional exclusions

Claude Code is working in parallel on synthetic repositories, product evaluation, ground truth, graders, benchmark expansion, product gaps, and Fettler or ReGauge fixes. Codex will not create a competing benchmark framework or rewrite those modules.

High collision risk areas intentionally avoided unless an interface join is required:

- `packages/eval/`
- synthetic repository fixtures and mutation generators
- `packages/code-impact/`
- broad Fettler or ReGauge planner changes
- unrelated API and worker fixes

The expected Claude evaluation boundary is a versioned, immutable result containing scenario identity, repository family, mutation identity, difficulty, ground truth reference, system output reference, grader version, grader result, corrected result, failure taxonomy, split class, and provenance. Codex will consume that boundary through an adapter. It will not write Claude's scenario generators, ground truth, graders, or hidden split membership.

Before each commit and before push, Codex will fetch current `origin/main`, inspect new commits and the working tree, and manually reconcile any overlap. No cleanup, reset, blind cherry-pick, sweeping formatting, or unrelated refactor is permitted.

At the first integration check, Claude's `codex/evals-harness` and `codex/synthetic-e2e` worktrees were based on `1f83b4a` and contained untracked evaluation and synthetic files. They are not stable imports yet. Main advanced by three unrelated product hardening commits to `a5ddda8`; none overlap the current learning files. Codex will rebase the first reviewed learning commit onto that main before touching shared product capture paths.

## Current local work

The branch contains one red-first corpus materialization test, an exported placeholder operation, and task planning changes. These predate the complete attached flywheel brief and are retained only as the first TDD boundary. They do not represent a finished design.
