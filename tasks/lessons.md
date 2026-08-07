### 2026-08-02 — Classify partial requirements precisely
**Mistake:** I described all partial requirements as waiting on external acceptance evidence before checking the registry categories.
**Correction:** Talal asked why 61 requirements were partial instead of fully done.
**Rule:** Before explaining requirement status, count external blockers separately from repository controlled gaps and promote only assertions whose complete acceptance evidence passes.

### 2026-08-05 — Boot every DDL change against an existing-schema database
**Mistake:** The Warden slice added a partial unique index on `agent_runs(tenant_id, job_id)` to the static DDL while `job_id` itself arrives via a later additive migration. Fresh databases (all tests, CI deployment-e2e) build the full table and pass; the existing production volume lacked the column, `raw.exec(DDL)` threw `no such column: job_id` before migrations ran, the machine crash-looped to its restart cap, and production went down until a manual image rollback.
**Correction:** Self-discovered during post-merge deploy verification; production restored by rolling back to the previous Fly image.
**Rule:** Any statement in the static DDL that references a column added by an additive migration must be created after that migration runs. Every schema change needs a regression test that opens a database created with the pre-change schema and asserts `createDb` boots and converges to the same shape as a fresh database. Treat green deployment-e2e as evidence for fresh installs only, never for upgrades.

### 2026-08-06 — Audit inherited changes before continuing
**Mistake:** The active goal contained inherited Claude changes whose implementation claims and release evidence had not yet been independently separated from later work.
**Correction:** Talal required a complete review of Claude's changes before continuing the broader goal.
**Rule:** When resuming work from another coding agent, first identify its exact commits and diff, independently verify behavior and release evidence, remediate confirmed defects, and only then build the next capability slice.
