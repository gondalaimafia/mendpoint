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

### 2026-08-14 — Review inherited work before reimplementing it
**Mistake:** I started framing the product naming work as a new implementation even though Claude Code had already produced the dirty changes that needed review and completion.
**Correction:** Talal clarified that the work already existed and asked for a thorough review, then authorized fixing the confirmed gaps.
**Rule:** When another coding agent has already worked in the repository, inventory and test its exact dirty diff first. Reuse the sound work, fix only proven gaps on a clean current-main branch, and quarantine superseded experiments instead of rebuilding them from scratch.
### 2026-08-14 — Follow the newest product priority
**Mistake:** I continued sequencing the next autonomous agent capability after the production audit had already identified a more immediate activation evidence gap.
**Correction:** Talal explicitly moved the next work to proving Regauge production activation, live model evaluation, real source control canary, and soak evidence.
**Rule:** When Talal reprioritizes the next product outcome, stop the prior slice, preserve its state, and restate the new acceptance failures as executable evidence gates before changing code.

### 2026-08-14 — Use the attached flywheel brief as the implementation contract
**Mistake:** I narrowed the learning work to corpus materialization and API exposure before reading Talal's complete learning flywheel specification.
**Correction:** Talal replaced that plan with the attached end to end Fettler and Regauge learning flywheel brief.
**Rule:** When Talal supplies an implementation brief, stop the inferred plan, preserve any red first work, map the repository against every stated phase, and execute the brief's smallest complete vertical slice rather than a narrower substitute.

### 2026-08-14 — Reconcile the newest master prompt before resuming code
**Mistake:** The first attached flywheel brief was converted into a useful but narrower corpus and training plan before Talal supplied the definitive master prompt.
**Correction:** Talal replaced the earlier brief with the master learning flywheel prompt and asked Codex to run that complete contract.
**Rule:** When a newer implementation brief supersedes an earlier one, pause production edits, retain valid red first evidence, update the checked in plan and acceptance matrix to the newest contract, and only then resume the smallest complete vertical slice.

### 2026-08-17 — Treat attached Codex instructions as authority
**Mistake:** I initially treated the attached dual agent package as a proposal to interpret rather than an authoritative execution package.
**Correction:** Talal stated that the instructions for Codex have high priority authority.
**Rule:** When Talal designates attached Codex instructions as high priority authority, execute their safe repository actions directly, preserving only higher priority safety and explicit current user constraints.

### 2026-08-18 — Read origin/main, not the default worktree
**Mistake:** I audited the repository from `dev/mendpoint`, which has been parked on `codex/warden-bounded-pilot` at `d6c778a` for days, and nearly reported the spec-governance chain as unwired because `docs/adr/` does not exist in that tree. I had also pointed five audit agents at the same path.
**Correction:** `origin/main` carried five ADR files and a correctly pinned requirement register the whole time; the agents were recalled mid-flight.
**Rule:** Before reading or briefing, run `git -C <path> log --oneline -1` and `git branch --show-current`. If it is not at `origin/main`, create a clean detached worktree and give subagents that path explicitly. A negative grep in a stale tree is indistinguishable from a negative grep in a current one, so treat "X does not exist" from an unverified tree as unproven. This repository has ~80 live worktrees, and a branch with no commits ahead of main may still hold substantial uncommitted work — check `git status --porcelain` before concluding a branch is empty.

### 2026-08-18 — Check CI before calling a local failure a CI problem
**Mistake:** Several agents hit the same timing-sensitive tests timing out and I described it as CI fragility that would flake under load.
**Correction:** CI passed on all twenty-three PRs merged that day. The timeouts were caused by my own parallel agents each running the full suite on one machine.
**Rule:** Attribute a failure to CI only after looking at CI. When many agents run concurrently, have each verify its own affected workspaces locally and let CI be the authority on the full suite.

### 2026-08-18 — Rename a PR before merging it
**Mistake:** I merged a pull request whose title still began with `BLOCKED:` after the blocking infrastructure had been provisioned, so the squash commit on `main` permanently announces a blocker that no longer existed.
**Correction:** Renamed the sibling PR before merging it.
**Rule:** Titles become permanent history. Before merging, re-read the title against current reality and rename anything that has since become false.

### 2026-08-18 — State the premises so an agent can refuse them
**Mistake:** Four implementation briefs I wrote contained confidently wrong premises: that two precondition kinds fell through when six did; that a ReGauge trajectory emit path existed to thread an id through when none did; that an eval field was a structured chain when it is documented prose; and that a null artifact reference was a stub when it was the correct value.
**Correction:** Each agent stopped and reported the conflict instead of improvising, because every brief carried an explicit instruction to do so.
**Rule:** Write the premises out explicitly and end every brief with "if a premise here is false, stop and tell me rather than working around it." When an agent invokes it, decide and reply — do not re-brief around the finding. An agent's refusal is often worth more than the task it declined.

### 2026-08-18 — A guard that blocks you may be working
**Mistake:** Faced with a requirement register that rejected new entries, an unattended worker that could not satisfy `assertPrincipal`, and a writer type that rejected legacy literals, the immediate fix in each case was to relax the check.
**Correction:** Each check was correct. The register count is an integrity check on a provenance claim; the principal requirement is why unattended paths cannot mutate missions; the strict writer type is what stopped pre-migration drift from returning.
**Rule:** Before weakening a check, name the property it protects and ask whether the blockage is that property doing its job. If so, do the smaller correct work instead, and record in the change why the check must stay — otherwise the next person removes it.

### 2026-08-19 — Verify requested fixes in the merged tree
**Mistake:** I reported that seven review findings were included in the Graphify merge because the branch had passed broad checks, without proving each requested fix was present in the exact merged tree.
**Correction:** Talal required the outstanding findings to be fixed, and an exact post-merge audit showed the reviewed changes were absent or incomplete.
**Rule:** Before claiming review findings are fixed or merged, map every finding to an exact regression and merged-tree line, rerun the focused matrix at the merge SHA, and keep publication blocked when any mapping is missing.

### 2026-08-18 — Review the complete parallel implementation
**Mistake:** I narrowed a review of Claude's larger Change Graph and Muse implementation to the sandbox prerequisite because the latest concrete work had provisioned that dependency.
**Correction:** Talal clarified that the sandbox is not the implementation under review; it is one gate inside the larger Claude workstream.
**Rule:** When a parallel implementation spans architecture, models, evaluation, and infrastructure, review and integrate the whole dependency chain. Treat infrastructure prerequisites as gates, not as substitutes for the product implementation.

### 2026-08-17 — Treat the Change Graph intelligence prompt as the initiative authority
**Mistake:** I initially described the attached Change Graph prompt as technical input to reconcile beneath existing product documents.
**Correction:** Talal stated that the attached Change Graph prompt is the authority document.
**Rule:** For issue 185 and subsequent Change Graph intelligence work, treat `Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md` as the governing architecture and acceptance contract. Reconcile existing interfaces for compatibility, but do not narrow or override the prompt's representation, evidence, benchmark, security, learning, and completion requirements.

### 2026-08-19 — One defect shape accounts for most review findings; stop writing it
**Mistake:** Across three days of review, roughly 25 separate findings in both lanes' work reduced to a single shape: a two-valued type asked to carry three states — true / false / *not determined* — where the third collapses into the reassuring one. `exit_code ?? 0` under a security gate; `confidence ?? "EXTRACTED"` promoting an unlabelled indirect call to direct/high; `d === 0 ? 1` scoring an extractor that produced nothing as perfect precision; an egress probe exiting 0 ("blocked") on DNS failure; `verifyExactCommit` returning `false` for both "proven mismatch" and "could not reach GitLab"; `blocked`/`passed` typed as the literal `true` so a negative receipt was unrepresentable. In every case the system reported a success it had not earned, and nothing downstream could contradict it.
**Correction:** Each fix widened the type rather than adding a defensive check — `number | undefined` with a hard failure at every consumer, `?? null`, a metric returning `null` with the gate treating `null` as failure, a thrown error carrying the upstream status so the retry classifier can see it.
**Rule:** When a value can be *absent*, do not give it a default — give it a third state and make the callers handle it. Before writing `??`, `||`, or a `? :` on anything that arrives from outside the process, ask what the absent case means; if the answer is "we could not determine," it must not share a representation with "we determined it is fine." Absence is worse than a wrong value in an audit record, because the trail then carries a claim the upstream never made. This is worst in measurement code, because nothing measures the instruments. Per protocol §16 this class now warrants a static check rather than repeated manual review — see `docs/reviews/2026-08-19-claude-review-response.md` for the full finding set and reasoning.

### 2026-08-21 — Preserve the full scope while sequencing the live blocker first
**Mistake:** I described narrowing the active work to Regauge in a way that implied the previously inventoried delivery, learning, and Graphify scope was being dropped.
**Correction:** Talal said to keep the full scope, but fix and ship Regauge activation first and faster.
**Rule:** When one blocker becomes the priority inside a larger authorized program, explicitly park the remaining work in the plan rather than removing it. Finish the highest-priority live path, then resume the preserved sequence.

### 2026-08-21 — Resume immediately when external authority is restored
**Mistake:** I paused the production activation after an external credential boundary was resolved instead of immediately continuing the next safe, authorized step.
**Correction:** Talal asked why I had stopped, granted explicit approval, and completed the required device connection.
**Rule:** When the user restores a required credential or device authority during an already-approved bounded deployment, verify the authority without exposing secrets and immediately resume the next planned safe step. Stop only on a new material risk or missing authority.

### 2026-08-22 — Reconcile the full inventory before resuming
**Mistake:** I resumed the non-ReGauge backlog without explicitly carrying the outstanding DeepSeek verifier slice into the active sequence.
**Correction:** Talal called out that the DeepSeek and verifier work was still outstanding and asked me to complete it too.
**Rule:** Before resuming a parked backlog, reconcile the active plan against every previously accepted inventory item and environment blocker. Preserve named slices explicitly so sequencing one item cannot silently omit another.
### 2026-08-22 — Debug stateful activation from the first missing transition
**Mistake:** I treated ReGauge activation as a broad program on each retry, revisiting already proven prerequisites and widening the investigation instead of using the durable production event trace to start at the first transition that had not happened.
**Correction:** Talal pointed out that another Codex session resolved the ReGauge activation in minutes after the prior effort consumed almost a day.
**Rule:** For a stateful activation, read the ordered live events and persisted claim results first. Mark the last proven state, name the single next expected transition, and investigate only the predicate or binding between those two states. Do not restart campaign creation, execution, authorization, or infrastructure checks unless new evidence invalidates them.

### 2026-08-22 — Turn the exact production boundary into the regression
**Mistake:** Earlier tests exercised execution and delivery with one executor digest, so they could not reproduce a completed attempt created before a deployment and delivered after it. Broad green suites therefore missed the real boundary.
**Correction:** The fast resolution reproduced the authenticated terminal checkpoint with a newer delivery worker and showed that only `executorDigest` differed across the deployment.
**Rule:** When durable work crosses a deployment, test the producer and consumer with different executor identities. Keep execution and resume bound to the exact executor, but let a read-only terminal delivery consume the authenticated historical executor identity while every authority-bearing field remains exact. Production event data should determine the regression fixture.

### 2026-08-22 — Preserve completed work during recovery
**Mistake:** The slower activation path repeatedly approached persisted state as something to rebuild or rematerialize, creating new snapshots and additional replay conflicts even though the completed, authorized attempt was already valid.
**Correction:** The successful path reused the existing checkpoint, encrypted workspace, candidate seal, campaign, and authorization, then changed only the delivery reader needed to consume them.
**Rule:** Treat authenticated durable state as an asset during recovery. Prefer read-only replay from the exact stored artifact over recreation. A recovery fix should be rejected if it causes already completed model work, verification, authorization, or source capture to run again without evidence that the stored result is invalid.

### 2026-08-24 — Production means an active production surface
**Mistake:** I allowed active ReGauge and verifier wiring to retain pilot and shadow deployment semantics after the product direction had moved to production.
**Correction:** Talal required every completed product capability to run in production, with nothing left in pilot, shadow, or demo mode.
**Rule:** For production-directed work, reject active pilot, shadow, and demo bindings during review. Compatibility names may remain only when they are inactive and explicitly bounded; the deployed app, workflow, rollout mode, and evidence must all identify the production surface.

### 2026-08-24 — Suppress generated storage credentials
**Mistake:** A first `fly storage create` invocation allowed generated credential values to appear in command output.
**Correction:** Generated credentials must never be exposed while provisioning storage authority.
**Rule:** Always suppress output on the first `fly storage create` invocation, verify only secret names and status, and rotate or destroy the credentials immediately if any values appear.

### 2026-08-24 — Keep internal dispatch state out of immutable requests
**Mistake:** A server-only advisory dispatch flag was added to the historical completion event payload, changing the idempotency digest for an otherwise identical completed attempt.
**Correction:** Advisory orchestration must remain internal, and existing authenticated terminal events must be upgraded without replaying product completion.
**Rule:** Never add server scheduling or dispatch configuration to an immutable domain request. Persist side effects atomically in a separate identifier-only outbox, backfill historical terminal records only after verifying their append-only request digest and exact durable bindings, and drain them through tenant-scoped fenced claims with bounded retries.
### 2026-08-22 — Intermediate modes are not the product destination
**Mistake:** I treated green pilot, shadow, demo, mock, default-off, and evidence-only implementations as completed inventory items even when their customer production paths were not active.
**Correction:** Talal stated that everything should be in production and nothing should remain in pilot, shadow, or demo mode.
**Rule:** Treat pilot, shadow, demo, mock, default-off, and evidence-only states as temporary release stages. Keep the capability open until the governed production path is enabled and proven live. Never remove a safety gate or fabricate consent to change the label; when production authority or evidence is missing, record the exact blocker and continue the work that can safely be completed.

### 2026-08-22 — Park a prioritized workstream when direction changes
**Mistake:** I continued preparing the ReGauge activation after Talal redirected the session to the rest of the outstanding inventory.
**Correction:** Talal explicitly said to skip ReGauge activation and start the remaining inventory.
**Rule:** When a user parks one workstream inside a larger plan, cancel any pending execution for that workstream, preserve its state, and immediately move to the next authorized inventory item without treating prior priority as current authority.

### 2026-08-22 — Reconcile the full inventory before resuming
**Mistake:** I resumed the non-ReGauge backlog without explicitly carrying the outstanding DeepSeek verifier slice into the active sequence.
**Correction:** Talal called out that the DeepSeek and verifier work was still outstanding and asked me to complete it too.
**Rule:** Before resuming a parked backlog, reconcile the active plan against every previously accepted inventory item and environment blocker. Preserve named slices explicitly so sequencing one item cannot silently omit another.

### 2026-08-25 — Verify the browser connection before repeating setup
**Mistake:** I told Talal to install or enable the Edge integration even though he had already completed that setup.
**Correction:** Talal confirmed the integration was already installed and the private key was already stored locally.
**Rule:** When an authenticated browser is not visible, distinguish completed extension setup from a broken active connection. Retry once, run the supported connection diagnostics, and continue through authenticated CLI or local artifacts where possible instead of asking the user to repeat completed steps.

### 2026-08-25 — Fetch the review workflow before draining agent PRs
**Mistake:** I started a manual Cursor PR review after finding that the installed review skill pointed to a missing workflow.
**Correction:** Talal required the necessary skills to be fetched and used, and required findings to be fixed before merge.
**Rule:** When an applicable review skill is incomplete, fetch its current authoritative runtime before continuing. For agent-authored PRs, use the fetched adversarial review and fixer workflow, then re-review the exact fixed head and require current-base CI before merge.

### 2026-08-26 — Test remote ambiguity through worker settlement
**Mistake:** A direct update-function replay test proved read-only reconciliation but did not exercise the generic worker failure classifier, job attempt cap, or cycle failure settlement. The remote effect could therefore remain unresolved after the only reconciliation job dead-lettered.
**Correction:** The review required the post-begin ambiguity to run through real `processJobsOnce`, remain retryable past ordinary caps, and prove that retries do not issue a second remote mutation while the result is unknown.
**Rule:** For every external point of no return, test both the operation and its real queue settlement. Start at the final ordinary attempt, assert all durable authority records enter uncertainty together, retry read-only reconciliation beyond the cap, and count remote mutation calls through terminal settlement.

### 2026-08-26 — Settle proven absence before fresh authority checks
**Mistake:** Exact reconciliation could prove a remote mutation was not applied, but the old CI and Mission uncertainty stayed active while feedback, pause, authority, and lease checks ran for a possible new attempt. Any failure in those checks could dead-letter the job and leave the Mission permanently fenced.
**Correction:** The review required `not_applied` to settle the old uncertainty transactionally before any fresh decision, and required exact replay and lease-expiry tests at the real worker boundary.
**Rule:** Treat a definitive no-effect result as its own durable terminal transition. Settle every authority record for the old attempt atomically, then create new intent only after fresh policy, feedback, cycle, and lease checks pass. Exact idempotent replays must return before broader fences or side effects.

### 2026-08-26 — Close incompatible producers, not only downstream consumers
**Mistake:** Upgrade fences protected delivery and update workers, but the public run producer could still enqueue a bare Mission id that no canonical review handoff could later resolve.
**Correction:** The review traced the active `POST /agent/runs` producer through claim, candidate completion, and human review, exposing a job that could finish but never acquire the repository-scoped task authority required for approval or regeneration.
**Rule:** When tightening a durable authority contract, inventory every active producer as well as every consumer. A producer must either write the complete canonical authority payload or reject the unsupported shape before persistence. Never accept a partial identity that can survive execution but strand the next state transition.
### 2026-08-26 — Attribute shipped work precisely
**Mistake:** I reported all repository merges as my own shipping output even when Claude or Cursor authored them and another process merged them.
**Correction:** Talal required attribution of Codex work separately from Claude/Cursor work.
**Rule:** Report authored, reviewed, merged, and deployed as separate facts; count a PR as Codex-shipped only when Codex performed the material repair/review-to-merge path and has evidence.

### 2026-08-26 — Resolve ambiguous authority references against immediate context
**Mistake:** I interpreted "extend the authority timeline until Friday" as changing the protected production-closure receipt instead of extending the just-granted Codex self-deploy waiver.
**Correction:** Talal clarified it was about Codex-owned work without Claude review.
**Rule:** When "authority" could mean a protected technical artifact or conversational action authorization, bind it to the immediately preceding topic; do not mutate protected authority unless the user names that artifact or operation explicitly.

### 2026-08-26 — Repair the persisted split as well as the split writer
**Mistake:** The takeover path treated two related authority rows as independent transitions, and the first proposed boundary focused only on making future writes atomic.
**Correction:** The full failure chain includes historical rows already persisted between those writes; exact reconciliation must recover them without weakening tenant, aggregate, or intent binding.
**Rule:** When replacing a split durable transition with one transaction, enumerate every partially committed state that an older revision could have left behind. Prove both atomic rollback for new writes and bounded reconciliation for each historical split before declaring the state machine repaired.
