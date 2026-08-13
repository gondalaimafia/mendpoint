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

### 2026-08-10 — Treat website claims as product requirements
**Mistake:** I treated gaps discovered from the public website as a request to edit the marketing website itself.
**Correction:** Talal clarified that the website is the source of product gaps and the work is to build those capabilities in Mendpoint.
**Rule:** When asked to build gaps from a claims matrix, use the claims as acceptance inputs, implement and verify the underlying product, and do not redirect effort to the publishing surface unless explicitly requested.

### 2026-08-10 — Browser extension profile detection
**Mistake:** I treated a diagnostic miss in Chrome's selected Default profile as proof that the ChatGPT extension was not installed.
**Correction:** Talal confirmed the extension is enabled in both Chrome and Edge.
**Rule:** Treat a profile-specific extension diagnostic as a connection or profile-selection problem when the user confirms installation. Retry the requested browser connection and diagnose the active profile before asking for reinstall.

### 2026-08-11 — Integrate parallel agent work from current main
**Mistake:** Parallel Claude and Codex work accumulated on divergent branches and dirty worktrees without one coherent release branch.
**Correction:** Talal required all work from both agents to be reviewed, merged, and shipped together carefully.
**Rule:** When parallel agents work on the same product, inventory provenance first, preserve dirty experiments, replay reviewed logical bundles onto current main, run the full combined gate, and ship only through one reviewed release candidate.
### 2026-08-12 — Build complete features before withholding shipment
**Mistake:** I interpreted "build but do not ship" as permission to stop at default-off library foundations.
**Correction:** Talal wants elaborate end-to-end features built into the application, with only merge, activation, deployment, and customer rollout withheld.
**Rule:** Separate implementation completeness from shipment state. When asked to build but not ship, integrate and verify the full local product path while leaving production flags, infrastructure activation, pushes, merges, and deployments untouched.
### 2026-08-12 — Recheck release holds and live flags
**Mistake:** I carried an earlier do not ship hold and default off assumption forward after the user changed both the publication decision and production activation state.
**Correction:** Talal explicitly lifted the shipping hold and stated that the production activation flag is on.
**Rule:** Before final publication or activation claims, use the latest user instruction and verify the live runtime state after the exact deployment instead of inheriting an older hold or configuration assumption.
