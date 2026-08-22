# Outstanding work, recorded 2026-08-22

Written at the end of a long session so nothing has to be rediscovered. Grouped by who can act. Every item states what would settle it, because several things recorded as blocked this week turned out to be already done.

Anything in section 3 is **settled** — it is recorded specifically so it is not re-investigated.

---

## 1. Owner actions — cannot be done from the repository

### 1.1 Grant tenant consent (blocks the first real ReGauge draft)

`learning_consents` is **empty** — no consent has ever been granted on the live deployment.

    POST https://mendpoint-talal.fly.dev/learning/consent
    { "purpose": "...", "residencyRegion": "...", "reason": "...",
      "idempotencyKey": "...", "consentVersion": 1 }

Authenticated as a **human trust principal** for `tenant_default`. An API key is rejected — that distinction is the control, so it cannot be delegated to a machine.

Two purposes are likely wanted:
- `verifier-external-model-egress` — external model calls for the verifier.
- `regauge-adaptive-regeneration` — lets reviewer corrections reach a ReGauge agent (added by the consent-gating change).

`purpose` is a free-text partition key with no enumeration, so a typo silently creates a new lane rather than erroring. Revocation is a new superseding row and takes effect on the next call with no redeploy.

### 1.2 Fire one installation event (blocks the first real Fettler analysis)

The pull-request webhook is **live and receiving genuine GitHub deliveries** for this repository, and refuses every one with `installation_not_authorized`.

Sole cause: `github_installations` row `151614362` has `account_id = null`. Every other condition passes. The row predates the additive migration that added the column.

**This self-heals.** `upsertGitHubInstallation` backfills via `COALESCE(account_id, ?)` from the signature-verified installation webhook. Reconfiguring repository access in the GitHub App settings fires an installation event, which fills the field, after which pull-request webhooks authorize.

A migration backfill would be **wrong** — a migration has no live GitHub call, so it could only invent an identity it cannot verify.

### 1.3 Configure the receipt-renewal environment

Scheduled egress-receipt renewal is implemented but inert until GitHub environment settings exist, which cannot be set from code:

- environment `sandbox-production-renewal` with a **deployment-branch restriction to the default branch** and **no required reviewer**;
- the signing key stored so that branch rule keeps it off untrusted branches;
- an org-scoped `ROTATION_FLY_API_TOKEN`;
- a paging sink secret.

The security argument depends on the branch restriction: GitHub runs scheduled workflows only from the default branch, which is what replaces the human-typed confirmation. Without the restriction the automation is inert, not unsafe.

### 1.4 Re-audit the public claims registry

The claims-drift gate is built and correct but **cannot merge** until someone re-observes the live endpoints and bumps `auditedRevision` in the same change.

Re-pinning alone would force three genuine 2026-08-17 live observations onto a revision that did not exist when they were taken — fabricating provenance to turn a gate green. Do not do that.

### 1.5 Accept or reject the open ADRs

Several ADRs remain `Proposed` while their code is merged and running. Acceptance is an owner act.

### 1.6 Close issue #141; decide issue #172

- **#141 is merely unclosed.** The dual-agent workflow demonstrably operates. Close it.
- **#172 is genuinely incomplete.** The shadow verifier is *structurally incapable* of a confident verdict even with a key: single-candidate packs and an evidence-kind cap make `ready_for_review` unreachable by construction. Fixing that is real work, not a wiring change.

---

## 2. Engineering follow-ups

### 2.1 Correct two register citations, then make reachability a gate

Two `verified` requirements cite tests for code nothing calls:
- `ME-SCM-006` → `execution-evidence.test.ts`
- `ME-GRF-006` → `confidence-calibration.test.ts`

The reachability check ships in **reporting** mode for exactly this reason. Once these are corrected, switch on `--strict` and chain it into `ga:check`. A soundness-invariant test already exists to make that safe.

Also unresolved from that run: **37 not-determined citations**, and five `packages/eval` cases that are transitive-deadness shapes — a caller exists but sits behind other unreached code.

### 2.2 Retire the old names, safe slices only

Scope: 278 files by filename, 525 by content, **14,833 occurrences**. Only about 3,900 are safe.

**Do:** documentation; leaf-package internal identifiers; `docs/PRODUCT_REQUIREMENTS.json` plus its union type in `packages/contract` (one commit — the type and the 90 data values move together); `packages/db` internal identifiers, **excluding** the event literals that sit on adjacent lines.

**Do not:** the twelve old-name tables (policy store, ReGauge control plane, pilot store — three separate databases); the six persisted `jobs.type` strings, three written as raw SQL a codemod cannot see; the hashed `audit_events`/`domain_events` strings; the route aliases (documented in-tree as permanent, and two `/transformer` routes have no new-name twin); Fly app and volume names; `@mendpoint/transformer` — retained deliberately for wire and storage compatibility.

**The trap:** `scripts/start-transformer-role.mjs` *sets* `MENDPOINT_PROCESS_ROLE = "transformer_coordinator"` and two TypeScript files *match* it. A TypeScript-only sweep renames the matchers and not the setter — the API then silently concludes it is not the coordinator, in production, with no compile error and no failing test. That file is reachable only via `fly.transformer.toml`.

Useful fact established live: production `audit_events` contains **zero** old-name values and `domain_events` is empty, so the hash-chain risk is theoretical on this deployment.

### 2.3 Give the learning flywheel a producer signal

Organization Memory has a correctly-governed write path and **no producer can feed it**: no attribution value means "organizational convention," and both production producers hardcode `model_behavior`. Ten of eleven destinations still have no sink.

Also: `MENDPOINT_REGAUGE_LEARNING_ENABLED` is checked in six places and set in **none** of the three Fly configs.

### 2.4 Scale the real-repository harness

Once milestone 1 lands (one repository, one injected defect, honest result), milestone 2 is a corpus. Do not scale before the first result is trustworthy.

### 2.5 Make ADR numbering collision-proof

Three collisions in one week (0004, 0009, 0011). Every agent correctly checked the next free number; two checking simultaneously get the same answer. The check is right and the scheme is wrong — content-addressed or date-prefixed identifiers would make it structurally impossible.

### 2.6 Record the in-band gate rule in the operating protocol

Six agents in one session backgrounded a long-running gate and stalled waiting for a notification. Every brief already says to run in-band; it keeps happening. Encode it in `docs/agents/OPERATING_PROTOCOL.md` rather than per-brief, and pair it with: reuse an installed worktree for small changes instead of provisioning a fresh one.

### 2.7 Smaller items

- `aggregateRouterOutcomes` in `router-adaptive.ts` became dead when `PolicyRouterRuntime` was removed — its only caller was unreachable. Wire or remove.
- `apps/worker/src/warden-pilot-intake.ts` still uses the presence-only gate that enrolment was just raised from. Different resource; same asymmetry.
- `/metrics/outcomes` is mounted but unlinked — the state the dashboard was in before it was wired.
- `MENDPOINT_EVAL_LIVE_TRANSFORMER` has no `RENAMED_ENV` entry.
- The self-serve console and API routes are a **rebuild**, not a restore — see `tasks/todo.md` for why.

---

## 3. Settled — do not re-investigate

- **The 13 August revert (#93) was never diagnosed, and the evidence is gone.** Established by elimination: the schema is innocent (no `ALTER`, no migration entries, both added indexes on their own tables); the Fly token change was a backward-compatible widening; #88 was exonerated by re-landing as #94; it was not a packaging failure. CI and Fly logs are past retention. Remaining candidates are #87, #89, #90, #92.
- **The reverted self-serve slices should not be restored.** Console superseded, routes auth-regressive, DB layers would be dead code including a credential-storing table, and `verify:config` is owned by `validateApiEnv`, which is gate-wired.
- **Three `AdaptiveSemanticReview.verification: { passed: true }` sites are benign.** Failure is representable through a different arm of the discriminated union, and the sealing path throws rather than swallowing. Widening to `boolean` would put an impossible `false` on the converged branch and make the type worse.
- **The deployed app is in real mode.** `GITHUB_MODE` is set as a live secret overriding `mock` in `fly.toml`. Any document claiming the deployment is mock-only is reading committed config, not reality.
- **`@mendpoint/transformer` stays.** Legacy internal package name for ReGauge's core engine, retained for wire and storage compatibility; customer-facing language is ReGauge.
