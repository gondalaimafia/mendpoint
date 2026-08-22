# Mendpoint Dual-Agent Engineering Protocol

## Purpose

Mendpoint uses Claude Code and OpenAI Codex concurrently for software development.

The objective is to gain the speed and independent reasoning benefits of two coding agents while preserving code integrity, architectural consistency, reviewer independence, security, auditability, and a clean Git history.

This protocol is binding for both agents.

## Core operating model

The system uses four controls:

1. **Single writer:** one task has one authoring agent.
2. **Isolated worktrees:** Claude and Codex never author simultaneously in the same working tree.
3. **GitHub as coordination bus:** issues, branches, PRs, checks, and ADRs are the shared state.
4. **Reciprocal peer review:** Claude-authored PRs are reviewed by Codex; Codex-authored PRs are reviewed by Claude.

The normal flow is:

`Issue → claim → isolated worktree → implementation → tests → PR → opposite-agent review → author fixes → re-review → CI → human merge`

## 1. Single-Writer Principle

Every engineering task has exactly one AUTHOR:

- Claude Code, or
- OpenAI Codex.

Only the AUTHOR may modify the task branch.

The other agent may inspect and review the work but MUST NOT modify the author's branch during peer review.

Never allow Claude Code and Codex to simultaneously edit the same worktree.

Never have both agents independently push to the same feature branch.

## 2. One Task = One Issue = One Branch = One PR

All non-trivial engineering work begins with a GitHub issue.

Branch naming:

- Claude: `claude/<issue-number>-<short-description>`
- Codex: `codex/<issue-number>-<short-description>`

Every branch must correspond to a clear task.

Every task should produce one reviewable PR unless a stacked/dependent PR is explicitly justified.

## 3. Task Claiming and Collision Avoidance

Before writing code, the AUTHOR must:

1. Read the task issue.
2. Read its native project instructions (`CLAUDE.md` or `AGENTS.md`).
3. Read this protocol.
4. Read relevant product-spec sections.
5. Read relevant ADRs.
6. Fetch the latest remote state.
7. Inspect open PRs and active issues.
8. Inspect likely overlapping files/subsystems.
9. Confirm no other agent is authoring the same task or branch.
10. Post or update a task claim on the GitHub issue when practical.

Recommended claim format:

```text
[CLAUDE] Claiming #123.
Branch: claude/123-fettler-contract-diff
Expected areas: src/fettler/*, src/graph/provider/*
Dependencies: none
Overlap detected: none
```

or:

```text
[CODEX] Claiming #124.
Branch: codex/124-learning-capture
Expected areas: src/learning/*, src/router/*
Dependencies: #123
Overlap detected: src/router/*; sequencing around #123 required.
```

If meaningful overlap exists, DO NOT independently edit the same high-risk area. Instead:

- serialize the tasks,
- re-scope the tasks,
- or use an explicit stacked/dependent PR.

Git resolving text conflicts is not a substitute for architecture coordination.

### 3.1 Windows worktree procedure

Mendpoint development on the primary Windows host uses sibling worktrees. Run these commands from a clean integration checkout. Do not run them from another agent's dirty worktree.

```powershell
$issueNumber = 123
$slug = "short-description"
$repositoryRoot = git rev-parse --show-toplevel
$worktreeRoot = Split-Path -Parent $repositoryRoot

git fetch origin

# Codex author
$codexBranch = "codex/$issueNumber-$slug"
$codexPath = Join-Path $worktreeRoot "mendpoint-$issueNumber-codex-$slug"
git worktree add -b $codexBranch $codexPath origin/main

# Claude author
$claudeBranch = "claude/$issueNumber-$slug"
$claudePath = Join-Path $worktreeRoot "mendpoint-$issueNumber-claude-$slug"
git worktree add -b $claudeBranch $claudePath origin/main

git worktree list
```

Create only the worktree for the assigned author. The two examples show the naming contract; they are not instructions to create two writers for one issue.

## 4. Source of Truth

Product behavior is governed, in order, by:

1. the canonical Mendpoint product and platform specification
2. accepted Architecture Decision Records (ADRs)
3. repository interfaces, schemas, and compatibility contracts
4. task-specific acceptance criteria

The single canonical specification is `docs/product/mendpoint-product-platform-specification-v3.md` (the v3.0 platform specification). The owner resolved this on 2026-08-18, recorded in `docs/adr/0004-canonical-product-specification-v3.md`, which supersedes `docs/adr/0001-canonical-product-specification.md`:

- `docs/product/mendpoint-product-platform-specification-v3.md` (v3.0) is the canonical product and platform specification and the release contract. The requirement register `docs/PRODUCT_REQUIREMENTS.json` is pinned to it and validated by the `npm run spec:check` gate. v3.0 is a development baseline: unimplemented detail is forward-looking contract, not a claim about current behavior.
- `docs/product/mendpoint-product-platform-specification.md` (v2.0) is superseded. It is retained unchanged only as history and no longer carries repository authority.
- `docs/FOUNDATIONAL_PRODUCT_SPEC.md` (v1.0) is superseded. It is retained only as history and no longer carries repository authority.

Accepted ADRs live in `docs/adr/`, following the numbering and status lifecycle described in `docs/adr/README.md`. New ADRs start from `docs/adr/0000-template.md`.

Canonical product names:

- **Fettler** — external API/SDK/provider change remediation
- **ReGauge** — internal and legacy modernization

Do not reintroduce Warden or Transformer as customer-facing product terminology.

Historical database values, migration identifiers, or compatibility-sensitive API values may remain where changing them creates risk. Prefer explicit canonical mappings rather than blind global renames.

## 5. Scope Discipline

The AUTHOR must implement the smallest coherent change that satisfies the issue.

Do not:

- perform unrelated refactors
- rename unrelated files
- reformat broad areas
- upgrade unrelated dependencies
- change public contracts without documenting them
- alter architecture merely because another design seems cleaner
- remove safety checks to simplify an implementation

If a separate problem is discovered, create or recommend a separate issue.

## 6. Architecture Changes

Any change materially affecting the following must determine whether an ADR is required:

- core domain models
- Change Graph architecture
- model router
- learning pipeline
- training/post-training infrastructure
- tenancy
- authentication/authorization
- persistence contracts
- public APIs
- deployment architecture
- Fettler/ReGauge boundaries
- verification semantics
- rollback semantics

Do not silently create architecture through implementation.

## 7. Parallel Work

Parallel work is encouraged when tasks are independent.

Before writing, inspect:

- open PRs
- changed files
- active issues
- dependency relationships

If two tasks touch the same high-risk subsystem, default to serialization rather than optimistic merging.

Do not manually copy unmerged code between worktrees.

If task B requires task A, explicitly declare the dependency.

## 8. Testing

Every behavior change must have appropriate verification.

Depending on the change, run:

- unit tests
- integration tests
- type checks
- lint
- build/compile
- database/migration validation
- security tests
- evaluation suites
- Fettler/ReGauge synthetic regression tests
- holdout tests where relevant

Never remove or weaken a failing test merely to make CI pass.

For bug fixes, add regression coverage whenever reasonably possible.

## 9. Commit Rules

Commits should be coherent and scoped.

Commit messages should explain intent.

Include an agent trailer when practical:

`Agent: Claude Code`

or:

`Agent: OpenAI Codex`

Never commit:

- live secrets
- local credentials
- `.env` files containing values
- generated credentials
- unrelated artifacts
- temporary debugging files

## 10. Pull Request Rules

Before opening or updating a PR:

- sync with the intended base
- resolve conflicts deliberately
- run required tests
- inspect the complete diff
- remove accidental changes
- document architecture implications
- document test evidence
- document rollback implications
- disclose unresolved risks

The PR must identify its authoring agent.

### 10.1 Current pull request checks

The current `CI` workflow exposes these pull request check names:

- `test`
- `release-gates`
- `container-builds`
- `deployment-e2e`

The `deploy` job runs only after a push to `main`. It MUST NOT be configured as a pull request requirement because it does not exist on pull request runs.

## 11. Reciprocal Peer Review

Every Claude-authored material PR must receive an independent Codex review.

Every Codex-authored material PR must receive an independent Claude review.

Preferred request:

- Claude-authored PR: `@codex review`
- Codex-authored PR: `@claude review`

If the GitHub integrations do not support those exact triggers in the installed configuration, use the available product-native review mechanism while preserving the same reviewer assignment.

Do not describe either trigger as operational until the requested reviewer posts an attributable review or acknowledgement on the pull request. A comment without an integration response is not review evidence.

The author may self-review before opening the PR, but self-review does not satisfy peer review.

## 12. Reviewer Independence

The REVIEWER acts as an independent staff-level engineer.

The REVIEWER MUST NOT:

- assume the implementation is correct
- optimize for agreement
- modify the author's branch while performing peer review
- approve solely because tests pass
- ignore product/architecture contracts

The REVIEWER must examine:

- task requirements
- canonical product specification
- ADRs
- affected call paths
- persistence effects
- error paths
- concurrency/idempotency
- security boundaries
- compatibility
- failure behavior
- rollback
- observability
- tests
- graph/model/router/learning implications where relevant

## 13. Review Resolution

The AUTHOR owns remediation of review findings.

After meaningful fixes:

1. push new commits
2. rerun relevant tests
3. request re-review

Do not mark substantive findings resolved without addressing them or recording a justified disagreement.

For unresolved architectural disagreement, escalate to the human maintainer.

## 14. Merge Rule

Neither coding agent may independently merge a material PR merely because the opposite AI reviewer found no defects.

Merge requires:

- peer review complete
- required CI green
- review conversations resolved
- branch/current-base requirements satisfied
- human merge decision unless explicitly delegated by repository policy

## 15. Credentials and Production Safety

Agents may use approved development and staging credentials.

Agents must not receive unrestricted production credentials by default.

Never expose secrets in:

- prompts
- Git
- issues
- PR bodies
- review comments
- durable logs

Destructive production actions require explicit human authorization unless governed by an already-approved automated process.

Share capabilities, not plaintext secrets. Prefer:

1. product/tool-native authentication
2. OS keychain/credential manager
3. approved secret manager
4. runtime environment injection
5. local untracked secret files only when necessary

## 16. Learning From Reviews

If the same failure class recurs:

- add/improve automated tests
- improve static checks
- update shared agent instructions if procedural
- add/update an ADR if architectural
- add a synthetic regression if product behavior
- improve the learning/evaluation system when appropriate

Do not depend on repeated manual reminders.

## 17. Definition of Complete

A task is complete only when:

- acceptance criteria are satisfied
- implementation is scoped correctly
- relevant tests pass
- regression coverage exists where appropriate
- peer review is complete
- substantive findings are resolved or explicitly escalated
- documentation/ADRs are updated where required
- CI is green
- PR is merge-ready

Working code without peer review is not complete.

## 18. Running Verification Gates

- Run verification gates in-band and read the output directly. Do not background a long-running gate (`npm install`, `npm run typecheck`, `npm test`, a suite) and end the turn waiting for a completion notice — the notice does not usefully arrive, and the turn stalls.
- Use a dedicated worktree per concurrent agent, always — even for a single-file change, and even when it costs a cold `npm install`. Branch isolation is not enough: the working directory is the shared resource, and two agents in one tree corrupt each other's commits and pushes. Reuse an existing installed worktree only when you can confirm no other agent is active in it. If you find a shared tree on an unexpected branch mid-task, stop and report rather than committing — that is the signal someone else is in it.
- Rebase onto current `main` and re-run the gates against the rebased tree before declaring done. `main` moves during a task; an earlier clean run on a stale tree does not certify the merge.

A stale reused tree can also fail gates for reasons unrelated to the change: a long-lived checkout's `node_modules` drifts from the current tree — for example, missing workspace symlinks for packages added since it was installed — so a fresh worktree is the safer default.
