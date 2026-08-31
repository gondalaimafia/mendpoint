### 2026-08-30 — Key version labels are not cryptographic identity

**Mistake:** Material lineage trusted a configured key ID without durably binding that label to the original key bytes, so a restarted process could reuse the ID with different material and compute a new lineage identity for revoked plaintext.
**Correction:** Persist an immutable, domain-separated fingerprint for every lineage key ID before lifecycle work and reject same-ID/different-key configuration at startup.
**Rule:** Any durable record that names cryptographic authority by key ID must also have protected, authenticated continuity of that ID-to-key binding. Rotation changes the active ID; it never redefines an existing ID.

### 2026-08-30 — Operation commitments are not material lineage

**Mistake:** Credential material lineage reused the complete operation commitment, so rotating A to B to A assigned the second A a different identity and let compromised material escape lineage revocation.
**Correction:** Derive lineage from a domain-separated keyed fingerprint of tenant, credential, and plaintext, then revoke every matching generation and reject later resurrection.
**Rule:** Idempotency answers whether one operation is an exact replay. Material lineage answers whether two generations contain the same credential. Keep those identities separate and make revocation follow the material across every generation.

### 2026-08-30 — Plaintext release authority commits inside the transaction

**Mistake:** Break glass revalidated owner authority after decrypt but before opening the completion transaction, leaving one final time-of-check to time-of-use window before the grant audit and operation row committed.
**Correction:** Revalidate live owner authority under the same transaction immediately before the grant audit and operation insert, including exact replay.
**Rule:** Every plaintext-release path places its final mutable authority check inside the durable commit boundary. An outside-transaction check is preparation, never release authority.

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

### 2026-08-27 — Test unpinned multi-tenant scheduler entry points
**Mistake:** I proved release-only scheduling only with a global tenant pin, while the production worker intentionally permits canonical configurations for multiple tenants without that pin.
**Correction:** Spec review found that a fresh unpinned database could report a healthy scheduler run while silently executing zero configured releases.
**Rule:** When a runtime accepts tenant-bound configuration independently of a global tenant selector, test the production call shape with that selector unset, multiple tenants, a fresh durable store, and replay before claiming the configuration is reachable.

### 2026-08-27 — Separate release plumbing from product progress
**Mistake:** I treated shipping gates, plumbing, and documentation as significant Mendpoint 101 engineering progress without closing a live product capability.
**Correction:** Talal required infrastructure motion to be reported separately from end-to-end production capability progress.
**Rule:** Report release plumbing separately and prioritize closing an end-to-end production capability; never inflate infrastructure motion as requirement progress.

### 2026-08-27 — Execute the authoritative plan directly
**Mistake:** I proposed creating or importing another GSD roadmap even though an authoritative plan already existed.
**Correction:** Talal required GSD execution, verification, and shipping mechanics to apply directly to the existing plan.
**Rule:** Do not duplicate an authoritative plan; planning duplication is delay, not progress.

### 2026-08-27 — Fence durable scheduler work across crashes
**Mistake:** A running schedule window had no expiring authority, and readiness treated creation time as evidence of release success.
**Correction:** Quality review reproduced a crash that left configured release polling permanently unclaimable while the worker reported healthy.
**Rule:** Long-running durable claims need expiry and generation fencing, and configured readiness must require a distinct durable success fact.

### 2026-08-27 — Redact identifier shape, not an allowed scheme list
**Mistake:** Source item redaction hashed HTTPS identifiers but returned other hierarchical URI schemes verbatim.
**Correction:** Quality review showed FTP and custom identifiers could expose credentials and private paths.
**Rule:** Digest every hierarchical `scheme://` identifier with domain separation; preserve only explicitly safe opaque identifier forms.

### 2026-08-27 — Verify line endings as a file contract
**Mistake:** A CRLF source file became mixed-EOL after localized edits.
**Correction:** Quality review required the worker entrypoint restored to its baseline CRLF convention without broad formatting.
**Rule:** For line-ending-sensitive files, inspect index and working-tree EOL before and after edits, normalize only the target file, and review the semantic diff separately.

### 2026-08-27 — Preserve durable identity formulas during redaction
**Mistake:** Expanding URI redaction also changed the established HTTPS digest formula, so an upgrade could create duplicate artifacts and dispatches for the same release.
**Correction:** Quality re-review required exact legacy HTTPS identity compatibility while applying the new domain-separated digest only to other hierarchical URI schemes.
**Rule:** Treat persisted identity formulas as versioned compatibility contracts; extend safety behavior around them without changing existing canonical inputs or digests.
### 2026-08-28 — Inventory deployed identities before declaring a production surface absent
**Mistake:** I treated the empty `mendpoint-regauge-production` app as evidence that ReGauge had no deployed production surface and failed to distinguish it from the live legacy `mendpoint-transformer-pilot` coordinator.
**Correction:** Talal pointed out that an app was already in production and required all app identities to be named correctly, production configured, and current.
**Rule:** Before any topology or readiness claim, enumerate every app, its role, state, deployed revision, profile, processes, hostname, and attached volumes. Distinguish created, deployed, running, production configured, and production proven; never infer one from another.

### 2026-08-29 — Update every authority layer as one compatibility set
**Mistake:** I initially followed the repository's stale sandbox image pin without reconciling it against the newer firewall policy, protected environment bindings, and last successful receipt.
**Correction:** Talal required every canonical app and its dependencies to be up to date, not merely renamed or deployed from current source.
**Rule:** For production authority, verify and update the image digest, executable policy digest, signed receipt scope, protected environment variables, consumer manifest, and deployed secret override as one compatibility set before retrying activation.

### 2026-08-29 — Treat deployed labels as claims, not source proof
**Mistake:** I initially treated the image's `GH_SHA` label as sufficient proof that its executable source matched current main.
**Correction:** The live container emitted an error contract absent from current source even though its label named current main.
**Rule:** Production freshness requires a newly built immutable digest from the exact reviewed commit plus behavioral probes. Never infer executable source identity from a mutable tag or image label alone.

### 2026-08-29 — Make recovery evidence durable before deletion
**Mistake:** Stale-marker recovery deleted the marker before appending its audit record, so an audit permission failure could erase the only recoverable evidence.
**Correction:** A production recovery attempt reproduced that ordering failure and required restoration from the exact captured marker bytes.
**Rule:** Move recoverable state to a transaction hold, persist and verify its audit evidence, then delete the hold. On any audit failure, restore the original state byte for byte and fail closed.

### 2026-08-29 — Enumerate the complete failure chain before retrying
**Mistake:** Earlier production closure work peeled one failing layer per CI cycle and treated each newly exposed failure as a separate surprise.
**Correction:** Talal required Codex to learn from that delay: after a second hidden layer or a retry that adds no evidence, stop retrying and enumerate every authority, identity, state, deployment, health, and evidence predicate locally.
**Rule:** A second hidden failure triggers a full-chain audit before the next mutation. Close every discoverable layer in one reviewed increment, then retry once with explicit evidence for each predicate.

### 2026-08-29 — Make multi-Machine authority rotation transactional
**Mistake:** The first sandbox authority fix updated Machines sequentially without preserving an immutable image identity or proving rollback and containment for a partial failure.
**Correction:** Exact-head review required digest-pinned updates, exact configuration restoration, and fail-closed containment evidence before rotating protected secrets.
**Rule:** For a stateful multi-Machine mutation, capture exact identities and configurations first, mutate only immutable targets, restore every attempted target on pre-commit failure, and repeatedly re-inventory plus stop the complete current set whenever rollback or post-commit authority cannot be proven. The original inventory is rollback evidence, not a safe containment boundary after capacity may have changed.

### 2026-08-29 — Rotation receipts belong only to the proposal that creates them
**Mistake:** A completed authority rotation receipt from PR #539 was copied into PR #537's current pull request bootstrap even though #537 did not change the authority policy or ledger.
**Correction:** The protected proposal verifier correctly treated that bootstrap binding as a new rotation request, then failed because no new append-only receipt existed; GitHub authority failed closed downstream.
**Rule:** Never carry an earlier pull request's rotation tuple into a new current-PR bootstrap. An ordinary successor proposal omits `authorityRotation`; only the exact proposal that changes policy or the rotation ledger may bind its newly appended receipt, issue time, and digests.

### 2026-08-29 — Rebuild subprocess authority after dropping privileges
**Mistake:** The customer backup transport captured root's `HOME` before dropping to UID 1000, so rclone tried to read `/root/.rclone.conf` even though object-store credentials and backup inputs were valid.
**Correction:** The subprocess environment must be valid for the identity that executes it and must not inherit implicit authority from the constructing identity.
**Rule:** When work crosses a privilege boundary, explicitly reconstruct every subprocess environment, filesystem path, and credential source for the post-drop identity. Omit privileged home directories and force tools to a deterministic empty configuration when all required authority is already provided explicitly.

### 2026-08-29 — Verify the complete privilege boundary and execution seam
**Mistake:** The first backup fix changed UID and GID without clearing supplementary groups, and its regression asserted configuration construction without observing the spawned rclone process.
**Correction:** Exact-head review showed that privileged group authority could survive and that deleting the runtime argument wiring would leave the test green.
**Rule:** A privilege drop must clear supplementary groups before changing GID and UID, then read back all three identity dimensions. A subprocess regression must observe the real spawn boundary, including final argv and environment, so removing the production wiring makes the test fail.

### 2026-08-29 — Validate each hypothesis against the called contract
**Mistake:** I initially blamed the repeated readiness sentinel because it used `createOnly`, without checking that the backend contract explicitly returns `exists` as a successful idempotent outcome.
**Correction:** Live status-only probes showed the real chain: listener bound, coordinator passed, Tigris returned `NoSuchBucket`, then 403 after the bucket name was corrected because the failed create attempt had also replaced credentials.
**Rule:** Before changing code, inspect every called contract and test the complete live failure chain. A plausible explanation is not a root cause. On the second hidden layer, enumerate configuration, authentication, transport, provider status, and containment evidence before another retry.

### 2026-08-29 — Prove the runtime state transition after deployment
**Mistake:** The protected workflow treated a successful worker deployment as if it started an existing stopped non-service Machine.
**Correction:** The exact live evidence showed the worker image and revision updated successfully while the Machine remained stopped and its only check reported that it had not started.
**Rule:** Deployment success proves configuration publication, not runtime state. For every required process, select the exact intended Machine, perform any required start transition explicitly, and wait for its named health check before declaring deployment healthy or advancing the release.

### 2026-08-30 — Bind production proof to the current run authority

**Mistake:** The ReGauge draft proof established exact remote PR state but accepted any nonempty durable authorization references, so an older run's draft could satisfy a new activation.
**Correction:** Require the current protected run's independently derived approval and evidence references on the durable delivery before remote state can count.
**Rule:** Every production proof must bind both the live object and its durable lineage to the exact current authority. Remote state alone cannot promote stale authorization.

### 2026-08-30 — Enumerate the entire activation failure chain before retrying

**Mistake:** The first stopped-worker repair focused on the observed state transition but left later containment ordering, pre-mutation topology, process restart continuity, and feature-state proof as separate hidden layers.
**Correction:** Review every mutation, proof, failure edge, and terminal step as one state machine before sending another protected run.
**Rule:** After a second activation defect appears, stop patching individual symptoms. Model preconditions, allowed transitions, continuous identity, all late failures, evidence publication, and containment together, then test adversarial fixtures for each edge.

### 2026-08-30 — Persist approval lineage separately from execution evidence

**Mistake:** The production gate validated the current delivery approval, but the durable draft record retained only execution and acceptance evidence, so a later proof could not establish which protected run authorized the existing draft.
**Correction:** Carry the configured approval allowlist through the gate decision, persist the exact matched approval on the draft, and append later-run authority without changing or redelivering the live pull request.
**Rule:** Authorization evidence is its own durable contract. Keep it distinct from execution and SCM evidence, update it idempotently on replay, and make the production proof consume the exact stored field rather than inferring authority from adjacent evidence.

### 2026-08-30 — Rotate idempotency with trusted authority epochs

**Mistake:** The worker reused one campaign-stable authorization idempotency key even when a later protected run supplied a new production approval and acceptance evidence, causing the durable store to reject legitimate reauthorization as a conflict.
**Correction:** Derive the effective mutation key at the trusted coordinator from the client operation key plus the exact server-validated approval and acceptance evidence.
**Rule:** Idempotency must be stable within one authority epoch and distinct across authority epochs. Never let an untrusted client select the authority component of a privileged mutation key.

### 2026-08-30 — Put production rollback outside the mutation job

**Mistake:** ReGauge activation relied on late steps in the same timeout-bounded job to contain failure, without an immutable pre-mutation snapshot or exact run ownership.
**Correction:** Snapshot and revalidate topology before mutation, quiesce the prior worker, mark every committed process with the exact activation run, and run rollback or containment in a separate always-evaluated job.
**Rule:** A production mutation job cannot be its own only watchdog. Preserve an exact rollback boundary before mutation, make the commit boundary machine-readable, and independently prove either exact restoration or run-scoped containment after failure or cancellation.

### 2026-08-30 — Hold one lease through cleanup and prove mutation ownership

**Mistake:** The activation serialized only its deploy job, so a later run could start while the earlier cleanup still held a stale snapshot; cleanup also restored that snapshot without proving the failed run had mutated the worker.
**Correction:** Move concurrency to the complete workflow lifecycle and make an exact run-and-attempt Machine marker the first owned mutation before quiescence.
**Rule:** A production lease covers preflight through terminal cleanup. Roll back only state carrying the current mutation marker; if no marker exists, report drift without overwriting it.

### 2026-08-30 — Containment proves safe terminal state globally

**Mistake:** Containment counted only current-run workers in the `started` state, so an untagged or `starting` worker could remain capable of becoming active after cleanup passed.
**Correction:** After coordinator commit, enumerate every worker regardless of tag, repeatedly stop every nonterminal worker, and pass only when all workers are `stopped` or destroyed.
**Rule:** Failure containment is global after the commit boundary and state based, not tag based. A failed stop can be retried, but success requires a fresh terminal-state inventory.

### 2026-08-30 — Keep activation evidence inside its proven availability boundary

**Mistake:** The final artifact called an internal experimental ReGauge canary continuous production even though the release contract had not passed GA acceptance.
**Correction:** Label the artifact as continuous internal activation and preserve the exact internal availability and experimental feature tier.
**Rule:** Deployment location does not determine product availability. Evidence and public claims must use the narrowest state actually proven; promote to GA only in a later evidence-bound change.

### 2026-08-30 — Fit recovery loops inside their independent watchdog

**Mistake:** Sequential worker stops and unbounded inventory calls let the nominally bounded containment loop exceed the cleanup job's own timeout at maximum cardinality.
**Correction:** Bound every external call, stop independent workers in parallel, wait for every result, and prove worst-case retry arithmetic stays below the watchdog with headroom.
**Rule:** A retry count is not a time bound. For every recovery loop, calculate inventory, mutation, delay, and final-proof time under maximum cardinality and reject any design that cannot complete before its independent watchdog.

### 2026-08-30 — Restore the whole topology or contain it

**Mistake:** Rollback verified the prior coordinator and target worker records but did not compare the complete Machine set, so an extra active worker could escape restoration proof.
**Correction:** Require exact full-snapshot equality across cardinality, Machine IDs, states, configurations, and images; record and health-check the new process incarnation when rollback legitimately restarts a worker; switch any incompatible drift to global worker containment.
**Rule:** Production rollback is a topology assertion, not a pair of object checks. Restoration passes only when the entire configurable topology and expected state are exact and any restarted process is healthy; otherwise fail closed and contain every unsafe worker.

### 2026-08-30 — Make control-plane state transitions explicit

**Mistake:** A configuration-only Fly Machine update relied on default start behavior, so marking or restoring a stopped worker could briefly execute it before the workflow issued a stop.
**Correction:** Use `--skip-start` for every configuration mutation and issue a separate start only when the recorded transition contract requires it.
**Rule:** Never assume a deployment or configuration command preserves runtime state. Suppress implicit starts, then perform and verify the exact intended state transition as a separate operation.

### 2026-08-30 — A failed rollback operation must enter containment

**Mistake:** The first exact-restore path ran under `set -e`, so a failed update, inventory, start, or stop could terminate cleanup before global containment ran.
**Correction:** Check every restore operation explicitly, preserve a transition result, and switch any failure to the bounded global containment path.
**Rule:** Rollback failure is an expected safety transition, not an unhandled shell error. Every rollback operation must have a bounded failure edge that reaches containment and terminal-state proof.

### 2026-08-30 — Scope workflow artifacts to the exact attempt

**Mistake:** ReGauge preflight and production evidence artifact names used only the commit SHA, so a GitHub rerun could collide with attempt-one artifacts or consume stale topology.
**Correction:** Bind every upload and matching download to commit SHA, workflow run ID, and run attempt.
**Rule:** Any artifact that carries production authority or rollback state must be uniquely named by the exact execution attempt. A rerun may reuse source, but it must never reuse mutable control evidence.

### 2026-08-30 — Expiry permits exact replay, never new authority

**Mistake:** The coordinator treated any already-authorized draft state as replayable after expiry, even when a later request introduced a previously unseen approval and acceptance set.
**Correction:** After expiry, require the exact current approval and every current acceptance reference to already be durable on every draft before calling the idempotent store path.
**Rule:** Expiry freezes authority. A post-expiry request may read or repeat an exact durable result, but it may not add, replace, or widen authorization evidence.

### 2026-08-30 — Budget the executable timeout, including kill grace

**Mistake:** Workflow timing arithmetic counted nominal command timeouts and sleeps but omitted `--kill-after` grace, proof-command latency, and a final terminal inventory.
**Correction:** Give live evaluation and each proof poll a whole-step hard bound, include those bounds in the authority guard, and calculate cleanup from timeout plus kill grace for every external call and retry round.
**Rule:** Production budget proofs use executable worst-case time, not optimistic latency. Include kill grace, retry delay, final proof, and fixed transition costs, then retain explicit watchdog headroom.

### 2026-08-30 — Compatibility namespaces must work as exact targets

**Mistake:** The remote proof counted legacy ReGauge branches for cardinality but required the exact expected branch to use only the new canonical prefix.
**Correction:** Accept the expected branch from either the canonical prefix or an explicitly validated compatibility prefix, while continuing to count every compatible namespace as one shared campaign boundary.
**Rule:** A compatibility alias cannot be observation-only. If durable state may legally retain the old identifier, every exact read, replay, proof, and cardinality check must accept that identifier without creating new work.

### 2026-08-30 — Park one lane without pausing the next wave

**Mistake:** I kept the skipped ReGauge activation lane in the active execution path instead of immediately advancing the next dependency-ready wave.
**Correction:** Talal told me to skip that lane and start from the next wave.
**Rule:** When a lane is explicitly parked, preserve it unchanged, remove it from the active critical path, and immediately move build and review capacity to the next dependency-ready engineering plan.
### 2026-08-30 — Optional boolean fields still require strict present-value validation

**Mistake:** SCIM POST and PUT treated every `active` value except boolean `false` as active, collapsing malformed strings, nulls, and numbers into the omitted-field default.
**Correction:** Preserve the existing default only when the attribute is absent. Reject every present non-boolean value before membership, audit, or version mutation.
**Rule:** For optional typed fields, distinguish absence from invalid presence with one shared parser, and regression-test both acceptance and byte-for-byte non-mutation on every write path.

### 2026-08-30 — Revalidate authority at the mutation boundary

**Mistake:** SCIM and service-principal handlers trusted authority captured before an awaited body read, so revocation during upload could survive into a later write transaction.
**Correction:** Revalidate the live credential, trust principal, and human manager membership after parsing and inside the exact transaction that performs the mutation.
**Rule:** Authentication before an await is only an initial observation. Every security-sensitive write must prove the complete current authority again under the same transaction as its state change.

### 2026-08-30 — Close every mutation sink in an authority repair

**Mistake:** The first live-authority repair covered body-bearing SCIM and service-principal writes but left synchronous DELETE, revoke, and tenant-membership sinks trusting request-time identity.
**Correction:** Enumerate every mutation sink, share one complete human-manager revalidator, and prove stale authority cannot mutate target state at each boundary.
**Rule:** An authority fix is complete only when every sink revalidates the full credential, principal, membership, session, and scope chain inside the same transaction as its write.

### 2026-08-30 — Presence is not configuration validity

**Mistake:** The customer profile required the SCIM binding variable by name but accepted empty or malformed JSON and did not bind its tenants to the production allowlist.
**Correction:** Parse required structured configuration with the runtime parser and validate its semantic identity set at startup.
**Rule:** Required JSON configuration must be parsed by the same contract as its consumer and must prove nonempty, semantically valid, exact-scope bindings before boot.

### 2026-08-30 — Request ceilings must apply during reads

**Mistake:** SCIM and service-principal handlers read the entire body before checking actual bytes and treated invalid negative content lengths as if no useful declaration existed.
**Correction:** Validate content length syntax first, count bytes incrementally, cancel the stream when it crosses the ceiling, and reject invalid UTF-8 before JSON parsing.
**Rule:** A payload limit that runs after full buffering is not a memory boundary; enforce it while streaming and test producer cancellation.

### 2026-08-30 — Prove optional integrations are absent-safe before deployment

**Mistake:** An externally gated SCIM integration became an unconditional customer-profile requirement without proving that production could boot while the binding was absent.
**Correction:** Keep the integration optional until its protected bindings exist, and test the SCIM-free customer launcher path before release.
**Rule:** Every optional external integration needs an absent-binding customer-profile deployment regression, and qualification must inventory every newly required runtime binding before merge.

### 2026-08-30 — Compare canonical authority paths, not locator strings

**Mistake:** The qualification loader compared raw artifact locator strings, so Windows slash aliases could assign two authority roles to the same file.
**Correction:** Resolve every protected artifact through the safe path boundary first, then reject duplicate canonical filesystem paths before reading or hashing bytes.
**Rule:** Security-sensitive file identity checks must compare canonical filesystem identities and include platform-specific alias regressions; raw path-string uniqueness is not an authority boundary.

### 2026-08-30 — Persist authority evidence at the encrypted boundary

**Mistake:** The secret envelope trusted current provider classification but discarded the provider attestation after audit, so provider-authority drift was not cryptographically bound to durable ciphertext.
**Correction:** Persist the exact attestation digest in both the envelope and lifecycle row, include it in outer AAD, and require an exact current provider-attestation match before unwrap.
**Rule:** Provider authority evidence must survive restart and be verified at every ciphertext consumption point; an audit-only digest is not a durable cryptographic binding.

### 2026-08-30 — Audit attempted secret access by actual outcome

**Mistake:** Break-glass emitted only a granted audit after successful unwrap, while unwrap denials could be unaudited or mislabeled through a granted-only callback. Rotation also staged source unwrap with a no-op audit.
**Correction:** Persist both granted and denied access outcomes, and place rotation source-access evidence inside the same fail-closed publication boundary as the replacement generation.
**Rule:** Secret-access audit callbacks carry the actual outcome. Never name an attempted access granted until the operation succeeds, and never suppress denied or staging access evidence.

### 2026-08-30 — Tenant references cannot select deployment-global secrets

**Mistake:** A tenant-created SCM connection could choose `env://GITHUB_TOKEN`, causing the request-scoped credential broker to fall back to one deployment-global token.
**Correction:** Require tenant-created connections to resolve a tenant-scoped durable lifecycle record unless an immutable server-owned tenant binding exists.
**Rule:** A tenant-controlled credential locator may never address process-global secret material. Compatibility fallback must be server-owned, tenant-specific, and impossible to select through request data.

### 2026-08-30 — New break-glass authority needs a new identity

**Mistake:** Break-glass audit IDs were derived from credential, generation, and reason, collapsing a later authorized attempt into an earlier event.
**Correction:** Bind the operation to an explicit request or attempt identity and use exact replay comparison for deliberate retries.
**Rule:** Security-sensitive idempotency identities distinguish exact replay from new authority. Similar payloads do not make separate access attempts the same event.

### 2026-08-30 — Transport request IDs are context, not replay authority

**Mistake:** Stable lifecycle audit IDs were compared against per-request transport IDs, so a legitimate retry with the same idempotency key conflicted after a partial failure.
**Correction:** Persist replay authority from the semantic request and keep transport request IDs only on attempt-specific evidence.
**Rule:** Idempotency identity must survive HTTP retries. Never include an ephemeral request ID in the exact comparison for a committed operation or resumable staged step.

### 2026-08-30 — Audit denials before every break-glass exit

**Mistake:** Break-glass validation returned before the audit callback for role, feature flag, reason, idempotency, and tenant failures.
**Correction:** Funnel every denial through one truthful attempt audit carrying the actual principal and request context, and replace the denial with a fail-closed audit error if persistence fails.
**Rule:** A secret access boundary has no unaudited rejection branch. Validation, authorization, policy, lookup, and decrypt failures all persist denied evidence before returning.

### 2026-08-30 — Secret-bearing replay digests require keyed commitments

**Mistake:** The lifecycle operation table stored a deterministic SHA-256 request digest whose plaintext component could be tested offline against a small candidate dictionary.
**Correction:** Compute a versioned HMAC commitment with an external key, persist its key ID, bind every semantic request field, and reject legacy or wrong-key replay.
**Rule:** Durable idempotency evidence for secret-bearing requests must be a domain-separated keyed commitment. An unkeyed digest is an offline oracle even when raw plaintext is absent.

### 2026-08-30 — Cryptographic purposes need distinct key material

**Mistake:** The envelope KEK catalog and request-commitment authority were validated independently, so identical 256-bit material could be configured for encryption and HMAC purposes.
**Correction:** Compare one-way key fingerprints at construction time and reject any commitment key that equals a configured envelope KEK without logging either value.
**Rule:** Separate cryptographic purposes at the configuration boundary. Distinct algorithms or domain strings do not make reused root key material safe.

### 2026-08-30 — Replay actors outlive credentials

**Mistake:** Lifecycle replay bound the semantic actor to an API-key-specific trust principal, so rotating the credential changed the replay identity even when the same owner or service remained authorized.
**Correction:** Bind replay to a stable human or service authority and record the current API key and credential principal separately on every audit event.
**Rule:** Credentials authenticate an actor but are not the actor. Durable replay identities follow stable authority; request evidence retains the exact credential used.

### 2026-08-30 — Security audit begins before route dispatch

**Mistake:** Break-glass denial auditing lived inside the route, so authentication and RBAC middleware could return 401 or 403 before the audit boundary ran.
**Correction:** Wrap the exact break-glass path before authentication and RBAC, audit unresolved or resolved denial context without changing successful dispatch, and return a fail-closed service error if audit persistence fails.
**Rule:** If middleware can deny a security-sensitive operation, its durable denial audit must wrap that middleware rather than depend on the route handler.

### 2026-08-30 — Credential minting cannot amplify authority

**Mistake:** The tenant-admin key route accepted arbitrary scopes, while wildcard scope was interpreted as owner authority.
**Correction:** Bound newly minted key permissions to the authenticated caller's effective role and scopes, and require current stable owner authority for break glass.
**Rule:** Credential issuance may preserve or attenuate current authority. It may never manufacture a stronger role or broader scope than the authenticated authority holds.

### 2026-08-30 — Rewrap and secret rotation are different operations

**Mistake:** Lifecycle rotation changed only the KEK envelope while retaining the same credential plaintext, then presented the result as credential rotation.
**Correction:** Require new resolver-bound credential material for a real rotation and retain material lineage so incident revocation reaches every successor that contains compromised material.
**Rule:** Changing cryptographic wrapping does not rotate a credential. Rotation means new secret material with explicit provenance; rewrap is named and authorized separately.

### 2026-08-30 — Break-glass release needs a final current-state fence

**Mistake:** Break glass checked active state before asynchronous provider decrypt, allowing a concurrent revocation to complete before plaintext returned.
**Correction:** Revalidate the exact generation, key binding, provider attestation, and active state transactionally immediately before completing authorization and returning plaintext.
**Rule:** Authorization for plaintext release is a commit-time decision. Any asynchronous work before release invalidates earlier mutable-state checks.

### 2026-08-30 — Revocation replay is still an authenticated operation

**Mistake:** An already-revoked generation returned early before actor, reason, idempotency, and audit comparison.
**Correction:** Persist a keyed semantic commitment and exact replay evidence for revoke, audit valid replay, and reject every drifted retry.
**Rule:** Terminal state does not erase replay authority. Idempotent security mutations compare the full authenticated request before returning their prior result.

### 2026-08-30 — Custody claims require provider evidence

**Mistake:** Locally supplied JSON could label an application-held KEK customer-managed without an external provider proving customer custody.
**Correction:** Describe locally imported key material as Mendpoint-custodied and reserve customer-managed claims for provider-authenticated evidence.
**Rule:** Custody is an attested property, not a caller label. Never infer customer control from configuration text or a boolean supplied alongside key bytes.
### 2026-08-30 — Retain cryptographic history by purpose

**Mistake:** One active HMAC key controlled both operation replay and material lineage, so rotating it broke exact replay and changed the identity of already revoked material.
**Correction:** Keep independent versioned keyrings, verify durable evidence with its stored key ID, and give pre-split rows an explicit fail-closed compatibility path.
**Rule:** Cryptographic key rotation never changes historical identity. Persist the purpose-specific key ID, retain verification keys for every live record, and reject the operation when required historical authority is unavailable.
### 2026-08-30 — Schema presence does not prove migration completion

**Mistake:** The lineage-key backfill ran only inside the column-add branch, so a crash after ALTER but before UPDATE made the partial migration permanent.
**Correction:** Run authoritative NULL-row backfill independently and idempotently on every startup, preserving NULL when historical identity cannot be proven.
**Rule:** Every multi-step migration must resume from each durable intermediate state. A newly present column is not evidence that its data migration completed.
### 2026-08-31 — Prove the customer-visible path before calling a pipeline capable
**Mistake:** I described Fettler's implemented components without first proving that a real production input had crossed every durable stage and produced the promised reviewable draft.
**Correction:** Talal said to make the complete provider-change-to-reviewable-PR path real.
**Rule:** A production capability exists only after one exact live input traverses every producer, claim, persistence, verification, authorization, and delivery boundary. Code presence, enabled flags, synthetic tests, and healthy processes are prerequisites, not capability proof.
