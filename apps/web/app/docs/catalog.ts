export const DOC_CATEGORIES = [
  "Specialist agents",
  "Understand change",
  "Connect and deliver",
  "Trust and verification",
  "AI platform",
  "Operations",
] as const;

export type DocCategory = (typeof DOC_CATEGORIES)[number];
export type DocStatus = "production" | "limited_availability" | "preview" | "internal";

export type ProductDoc = Readonly<{
  slug: string;
  title: string;
  category: DocCategory;
  summary: string;
  status: DocStatus;
  statusLabel: string;
  availability: string;
  lastVerified: string;
  startHere: Readonly<{ intro: string; steps: readonly string[]; command?: string }>;
  capabilities: readonly string[];
  useWhen: readonly string[];
  howItWorks: readonly string[];
  interfaces: readonly Readonly<{ name: string; kind: "API" | "Command" | "Event" | "Configuration" | "Artifact"; detail: string }> [];
  evidence: readonly Readonly<{ label: string; locator: string }> [];
  guardrails: readonly string[];
  limitations: readonly string[];
  related: readonly string[];
}>;

const verified = "2026-08-14";

export const PRODUCT_DOCS: readonly ProductDoc[] = Object.freeze([
  page({
    slug: "fettler",
    title: "Fettler — the first AI API Engineer",
    category: "Specialist agents",
    summary: "Turn submitted OpenAPI changes into evidence backed migration pull request candidates for supported GitHub repositories.",
    status: "limited_availability",
    statusLabel: "Limited availability",
    availability: "Submitted OpenAPI JSON and configured GitHub pilot repositories",
    startHere: {
      intro: "Connect one approved repository, materialize an immutable snapshot, and start a bounded Fettler run.",
      steps: ["Install and authorize the GitHub App for the selected repository.", "Create an exact repository snapshot and verification profile.", "Submit a Fettler run or an approved API-change plan.", "Review the candidate, evidence, spend, and mission history before delivery."],
      command: "npm run agent:demo",
    },
    capabilities: ["OpenAPI change remediation and impact analysis", "Bounded repository diagnosis, source observation, edits, and verification", "Durable mission plans, checkpoint takeover, verifier-driven replanning, and terminal evidence", "Human candidate approval, draft delivery, CI observation, and bounded same-branch repair", "Current head requested change feedback reentry under inherited cumulative budgets"],
    useWhen: ["A provider API or SDK change affects an approved repository.", "An integration test fails and the repair scope is known.", "A team needs a proposed patch with exact evidence rather than an autonomous merge."],
    howItWorks: ["Fettler binds the task to one tenant, repository snapshot, allowed path set, model policy, and verification profile.", "It creates an evidence-grounded mission plan and executes only the current authorized step.", "Repository reads, mutations, model decisions, and verifier results are checkpointed under the active worker lease.", "The attempt returns a sealed candidate and evidence package for a fresh human decision.", "Approved candidates can become draft pull requests. Fettler does not merge or deploy."],
    interfaces: [api("POST /agent/runs", "Create a bounded Fettler run."), api("GET /agent/runs/:id", "Read run state and evidence."), api("POST /agent/runs/:id/candidate/review", "Approve, reject, or regenerate a candidate."), command("npm run eval:warden", "Run the deterministic Fettler benchmark."), artifact("Fettler terminal evidence", "Authenticated checkpoint outcome archived with the agent run.")],
    evidence: [evidence("Agent runtime and mission plans", "packages/agent/src/agent.test.ts"), evidence("Attempt and takeover behavior", "packages/agent/src/attempt-engine.test.ts"), evidence("Worker delivery and CI reentry", "apps/worker/src/warden-candidate-update.test.ts")],
    guardrails: ["Every mutation must match the active plan step and observed source evidence.", "Allowed paths, budgets, verification commands, and model authority are immutable attempt bindings.", "Remote delivery requires fresh human approval and exact-head reconciliation.", "No Fettler path can merge or deploy a pull request."],
    limitations: ["Language and migration coverage is bounded and unsupported work can abstain.", "Review feedback reentry requires fully paginated, current head, active GitHub change requests and does not widen the approved path scope.", "Production depth depends on the connected repository and configured verifier."],
    related: ["change-ingestion", "change-graph", "verification-attestations", "draft-delivery"],
  }),
  page({
    slug: "regauge",
    title: "Regauge — the first AI Legacy Engineer",
    category: "Specialist agents",
    summary: "Regauge is an experimental planning preview.",
    status: "preview",
    statusLabel: "Experimental planning preview",
    availability: "Durable campaign planning and review controls; repository execution and staged pull request campaigns are not customer ready",
    startHere: {
      intro: "Evaluate the planning preview against an approved snapshot without authorizing customer repository execution.",
      steps: ["Connect and snapshot an approved preview repository.", "Submit a migration objective to POST /transformer/missions.", "Inspect the derived blueprint, constraints, and rollback plan.", "Record an independent review decision and retain the planning evidence."],
    },
    capabilities: ["Objective-to-blueprint mission planning with CODEOWNERS and organization constraints", "Signed deterministic recipe selection and compilation", "Durable campaign plans with units, waves, budgets, exceptions, rollback plans, and review evidence", "Independent blueprint review and exact planning evidence", "Internal execution, checkpoint, and draft-delivery primitives behind separate non-customer gates"],
    useWhen: ["A team is evaluating how a larger migration could be staged.", "The repository matches an approved deterministic planning recipe.", "Independent blueprint review and exact rollback planning are required."],
    howItWorks: ["The mission planner re-verifies exact snapshot bytes, topology, owners, and policy before selecting one recipe or abstaining.", "An independent reviewer evaluates the integrity-bound blueprint.", "The compiler creates a durable campaign plan with units, dependencies, waves, budgets, and evidence authority.", "The preview retains the plan and review evidence without granting customer repository execution.", "Execution and staged draft delivery remain outside the customer-ready preview posture."],
    interfaces: [api("POST /transformer/missions", "Plan a repository-backed migration mission."), api("POST /transformer/control-plane/campaigns/:campaignId/review", "Record independent blueprint review."), api("GET /transformer/executions/:campaignId", "Inspect execution state."), command("npm run eval:transformer:canary", "Run the deterministic Regauge canary."), configuration("MENDPOINT_TRANSFORMER_GATE", "Tenant, environment, boundary, and production-delivery authority.")],
    evidence: [evidence("Mission planning and compilation", "packages/transformer/src/mission-planner.test.ts"), evidence("Pilot execution and checkpoints", "packages/transformer/src/pilot-execution.test.ts"), evidence("Multi-node worker", "apps/worker/src/transformer-multinode-service.test.ts")],
    guardrails: ["Blueprint planner and approving reviewer must be independent authorized principals.", "Planning cannot widen paths, recipe scope, budgets, or source authority.", "Stale or mismatched source evidence fails closed.", "Preview access does not grant repository mutation or delivery authority."],
    limitations: ["Repository execution and staged pull request campaigns are not customer ready", "No dedicated Regauge deployment is claimed live.", "Adaptive model planning and legacy extraction use separate gates and are not implied by the planning preview."],
    related: ["repository-connections", "draft-delivery", "deployment-operations", "learning-system"],
  }),
  page({
    slug: "change-ingestion",
    title: "Change ingestion",
    category: "Understand change",
    summary: "Normalize versioned API and release evidence into deterministic changes with explicit compatibility classifications.",
    status: "limited_availability",
    statusLabel: "Mixed availability",
    availability: "OpenAPI active; GraphQL and several release sources are gated previews",
    startHere: { intro: "Submit a versioned provider schema or poll an approved feed, then inspect the normalized change set.", steps: ["Create or select a provider.", "Publish a versioned OpenAPI document or configure an approved feed.", "Run detection for the monitored consumer.", "Review breaking, non-breaking, and new-capability findings before fanout."] },
    capabilities: ["OpenAPI JSON structural normalization and diffing", "GraphQL SDL and introspection normalization with canonical digests", "Breaking, dangerous, non-breaking, and additive classification with migration hints", "npm SDK release probes and compatibility signals", "RSS, Atom, GitHub Releases, provider-page, and registry document adapters as tested library components", "Manual provider announcements and redacted incident evidence"],
    useWhen: ["A provider publishes a new schema or SDK release.", "A team needs exact compatibility evidence before impact analysis.", "A manual announcement or incident must enter the same review trail."],
    howItWorks: ["Source bytes are bounded, normalized, and content addressed.", "The selected baseline and new version are compared structurally rather than by prose alone.", "Each change receives a stable identity, severity, location, and migration hint.", "Reviewed changes can fan out into graph impact and Fettler planning."],
    interfaces: [api("POST /providers/:slug/versions", "Store a versioned provider schema."), api("POST /providers/:slug/publish-version", "Publish and classify a version."), api("POST /feeds/poll", "Poll configured feeds."), api("POST /graphql/schemas", "Store and diff GraphQL SDL or introspection when enabled."), api("POST /change-sources", "Submit reviewed manual change evidence when enabled.")],
    evidence: [evidence("OpenAPI normalization and diff", "packages/change-intel/src/index.test.ts"), evidence("GraphQL normalization and diff", "packages/change-intel/src/graphql-schema.test.ts"), evidence("Catalog polling", "packages/catalog/src/poll.test.ts")],
    guardrails: ["Tenant and source identity are derived from authenticated authority, not request claims.", "Immutable version labels reject changed-content replay.", "Oversized, malformed, contradictory, or cross-tenant evidence fails closed."],
    limitations: ["GraphQL ingestion is gated by MENDPOINT_GRAPHQL_INGESTION_ENABLED.", "PyPI is declared as a signal type but no live PyPI probe is implemented.", "General changelog ingestion adapters are tested library code; continuous production use is not implied."],
    related: ["fettler", "change-graph", "repository-connections"],
  }),
  page({
    slug: "change-graph",
    title: "Change Graph",
    category: "Understand change",
    summary: "Resolve an API change through repository evidence to affected operations, fields, files, symbols, tests, owners, and migration outcomes.",
    status: "limited_availability",
    statusLabel: "Production pilot",
    availability: "Real connected snapshots with bounded language and evidence coverage",
    startHere: { intro: "Materialize a repository snapshot, index it, and query an approved change or consumer.", steps: ["Create the exact repository snapshot.", "Build or load the repository index and call graph.", "Attach the provider change and consumer binding.", "Query blast radius and inspect truncation, confidence, and evidence."] },
    capabilities: ["API surface and consumer impact graphs", "Repository, commit, pull request, file, symbol, test, owner, runtime, migration, and evidence nodes", "AST, LSP, Git, control-plane, impact, and outcome ingestion", "Callers, paths, field consumers, migration readiness, and reverse reachability queries", "Incremental persistent indexes and temporal evidence"],
    useWhen: ["A change must be mapped to concrete code and tests.", "A reviewer needs provenance behind an impact claim.", "A campaign needs owners and dependency ordering."],
    howItWorks: ["Schema and repository observations become typed, tenant-scoped graph nodes and edges.", "Bounded traversals expand from the changed surface into consumers and code evidence.", "Static, graph, and heuristic evidence are combined without hiding uncertainty.", "Outcomes feed durable graph evidence for later planning and evaluation."],
    interfaces: [api("GET /graph/changes/:id", "Resolve the impact graph for a change."), api("GET /graph/consumers/:id", "Resolve evidence for a consumer."), api("POST /graph-learn/query", "Run a bounded knowledge-graph query."), api("GET /graph/agent/mermaid", "Render the agent graph as Mermaid."), artifact("Repository evidence graph", "Snapshot-bound nodes, edges, source refs, and truncation metadata.")],
    evidence: [evidence("Change graph", "packages/graph/src/graph.test.ts"), evidence("Knowledge graph", "packages/graph-learn/src/graph-learn.test.ts"), evidence("Code impact", "packages/code-impact/src/index.test.ts")],
    guardrails: ["Every repository observation is bound to tenant, repository, snapshot, revision, and content digest.", "Traversal limits are explicit and truncation is surfaced.", "Static evidence never claims to observe runtime-generated behavior it cannot see."],
    limitations: ["Language frontends have different depth and precision.", "Runtime, CI, deployment, and ownership evidence is only as complete as the configured ingestors.", "The current hosted demo can contain seeded data; connected snapshots are the authority for customer results."],
    related: ["change-ingestion", "fettler", "regauge"],
  }),
  page({
    slug: "repository-connections",
    title: "Repository connections",
    category: "Connect and deliver",
    summary: "Authorize least-privilege source access and materialize immutable repository snapshots at exact revisions.",
    status: "limited_availability",
    statusLabel: "GitHub production path",
    availability: "GitHub App pilot path. GitLab delivery is on the roadmap.",
    startHere: { intro: "Install the Mendpoint GitHub App for an approved account and select the exact repositories it may access.", steps: ["Create or open the GitHub App install URL.", "Complete the installation callback for the tenant account.", "Register the allowed repository and selected branch.", "Materialize an exact immutable snapshot before any agent run."] },
    capabilities: ["Tenant-bound GitHub App installation and repository authorization", "Short-lived installation tokens restricted to selected repositories", "Exact commit resolution, immutable file manifests, modes, hashes, and retention", "Connection revocation and snapshot purge", "Generic SCM capability adapters for GitHub, GitLab, Bitbucket, and Azure DevOps"],
    useWhen: ["Fettler or Regauge needs authoritative source bytes.", "A repository must be read without storing a long-lived user token.", "A later worker must reconstruct the exact prior source state."],
    howItWorks: ["An authenticated tenant administrator authorizes a GitHub account and selected repositories.", "Mendpoint exchanges App authority for repository-scoped installation tokens.", "The snapshot service resolves one revision, materializes bounded files, and persists an immutable manifest.", "Agents receive snapshot bindings, not an unrestricted repository handle."],
    interfaces: [api("GET /github/app/install-url", "Start a GitHub App installation."), api("POST /github/app/callback", "Bind the installation to the authenticated tenant."), api("POST /platform/scm/repositories", "Register an approved repository."), api("POST /platform/scm/repositories/:id/snapshots", "Materialize an exact snapshot."), api("POST /platform/scm/connections/:id/revoke", "Revoke a connection.")],
    evidence: [evidence("GitHub App lifecycle", "packages/github/src/app-lifecycle.test.ts"), evidence("Repository source", "packages/platform/src/repository-source.test.ts"), evidence("Connection API", "apps/api/src/repository-connections.test.ts")],
    guardrails: ["Tenant, account, installation, repository, and remote repository IDs must agree.", "Snapshot paths, symlinks, file sizes, modes, hashes, and totals are validated.", "Tokens are scoped, short-lived, and never embedded in snapshot artifacts."],
    limitations: ["The main hosted demo uses mock GitHub; real delivery requires a customer or dedicated profile with App credentials.", "End to end GitLab onboarding, checkout, delivery, review, and revocation are not available.", "Bitbucket and Azure DevOps remain partial adapters."],
    related: ["draft-delivery", "security-governance", "fettler", "regauge"],
  }),
  page({
    slug: "draft-delivery",
    title: "Draft delivery",
    category: "Connect and deliver",
    summary: "Publish one exact, review-first source change to a draft pull request and reconcile uncertain responses without duplicate delivery.",
    status: "limited_availability",
    statusLabel: "GitHub production path",
    availability: "GitHub draft delivery for approved pilot repositories. GitLab delivery is on the roadmap.",
    startHere: { intro: "Approve a sealed candidate whose source, files, verification, and target repository still match current authority.", steps: ["Review the candidate and verification evidence.", "Record a fresh human approval bound to the exact candidate and head.", "Authorize deterministic draft delivery.", "Observe the remote draft and reconcile exact branch, commit, and pull request evidence."] },
    capabilities: ["Exact-base branch creation and content-addressed Git commits", "File bytes and executable mode preservation", "Draft-only pull request creation", "Same-request replay, response-loss adoption, and drift rejection", "Required-check observation and bounded same-branch Fettler repair after fresh approval", "Authoritative current head requested change observation and bounded repair reentry"],
    useWhen: ["A verified candidate is ready for human code review.", "A worker may crash after a remote write.", "A failed CI head needs one approved same-branch repair."],
    howItWorks: ["The delivery intent binds repository, base SHA, branch, commit tree, candidate digest, and approval.", "The GitHub App creates or adopts the exact commit and draft pull request.", "A post-read verifies remote identity and bytes before local completion.", "Uncertain writes enter read-only reconciliation; divergent state pauses for human review."],
    interfaces: [artifact("Exact draft intent", "Repository, base, branch, tree, commit, PR, approval, and idempotency binding."), event("Draft delivered", "Immutable commit and pull-request evidence."), event("Draft observed", "Required checks, review state, and exact head evidence."), api("POST /agent/ci-cycles/:id/pause", "Stop new Fettler CI repair authority.")],
    evidence: [evidence("Exact GitHub draft", "packages/github/src/index.test.ts"), evidence("Existing draft update", "packages/github/src/exact-draft-update.test.ts"), evidence("Draft observation", "packages/github/src/exact-draft-observer.test.ts")],
    guardrails: ["Delivery is draft-only and cannot merge or deploy.", "Human approval is candidate-specific and expires on changed authority.", "Review comments are untrusted evidence and do not authorize mutation.", "Every feedback repair requires fresh Mendpoint human approval before the branch changes.", "The final remote side effect requires a current lease, pause state, expected head, and one-use intent."],
    limitations: ["Feedback reentry accepts only fully paginated, current head, active GitHub change requests under the existing cumulative cycle budget.", "Production availability depends on App permissions and exact tenant-repository installation binding.", "Cross-SCM feature parity is not complete."],
    related: ["repository-connections", "verification-attestations", "fettler", "regauge"],
  }),
  page({
    slug: "verification-attestations",
    title: "Verification and attestations",
    category: "Trust and verification",
    summary: "Run approved repository and contract checks, retain exact evidence, and optionally sign a formal software attestation.",
    status: "limited_availability",
    statusLabel: "Verification production; attestations gated",
    availability: "Repository verification in active flows; formal attestation API requires explicit enablement and signing authority",
    startHere: { intro: "Define a repository verification profile, run it against the immutable candidate, and inspect the evidence before approval.", steps: ["Select approved commands from repository policy.", "Run baseline and post-edit verification in the bounded workspace.", "Store stdout, stderr, status, artifact digests, and comparison evidence.", "When enabled, issue and verify a DSSE-wrapped in-toto statement for the exact artifact scope."] },
    capabilities: ["Allowlisted npm, Node, Python, Go, Rust, Maven, Gradle, and RSpec verification profiles", "OpenAPI breaking gates and API design review", "Baseline versus post-edit comparison and scoped waivers", "Immutable evidence records and verification artifacts", "in-toto Statement v1 inside DSSE with Ed25519 thresholds, expiry, revocation, and exact scope verification"],
    useWhen: ["A candidate must prove configured checks before delivery.", "A reviewer needs immutable evidence rather than a success label.", "A downstream system requires a signed software statement."],
    howItWorks: ["Repository policy supplies the only commands eligible for execution.", "The runner records exact inputs, outputs, status, timestamps, and digests.", "Delivery gates consume authenticated evidence and fail on stale or mismatched scope.", "The optional attestation service signs the exact deterministic statement bytes and verifies signatures before parsing payload content."],
    interfaces: [configuration("Repository verification profile", "Approved commands, bounds, environment, and waiver authority."), artifact("Verification evidence", "Command, result, output digests, and source/candidate binding."), api("POST /advanced-ai/attestations", "Issue an attestation when advanced AI applications are enabled."), api("GET /advanced-ai/attestations/:id", "Retrieve and verify stored attestation evidence.")],
    evidence: [evidence("Repository command verifier", "packages/repair/src/verify.test.ts"), evidence("Contract gates", "packages/contract/src/contract.test.ts"), evidence("DSSE and in-toto", "packages/contract/src/software-attestation.test.ts")],
    guardrails: ["Arbitrary shell syntax is rejected and production commands come from approved policy.", "Waivers are attributable, scoped, and expiring.", "Attestation keys are injected authority; private keys never enter the statement or evidence.", "Signature verification happens before JSON parsing and exact scope checks."],
    limitations: ["Network isolation is supplied by deployment infrastructure, not the command parser alone.", "Security scan evidence can be caller-supplied unless a configured scanner produces it.", "Formal attestations are gated by MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED and signing configuration."],
    related: ["draft-delivery", "security-governance", "post-trained-models"],
  }),
  page({
    slug: "model-router",
    title: "Model router",
    category: "AI platform",
    summary: "Select a policy-eligible deterministic recipe, adapter, local model, open model, or frontier provider for each structured task.",
    status: "limited_availability",
    statusLabel: "Runtime component",
    availability: "Used by specialist runtimes; configured providers and executors vary by deployment",
    startHere: { intro: "Register only approved executors, then route a structured task under tenant risk, data, region, quality, latency, and budget policy.", steps: ["Create an executor registry with immutable descriptors.", "Define the tenant task and routing policy.", "Resolve the ranked eligible candidates.", "Dispatch through the selected executor and persist routing evidence, cost, and outcome."] },
    capabilities: ["Eligibility filtering by tenant, capability, tool, region, data classification, risk, cost, latency, and health", "Deterministic ranking with recipe preference when requirements match", "Circuit breakers, bounded retries, policy-bound fallback, and human handoff", "OpenAI, Anthropic, Gemini, xAI, Muse Spark, and OpenAI-compatible provider adapters", "Durable routing and provider provenance evidence"],
    useWhen: ["A specialist workflow needs model or recipe selection under policy.", "A tenant needs region, privacy, cost, or risk constraints.", "A provider failure should fall back only to another explicitly authorized executor."],
    howItWorks: ["The caller submits a structured task spec rather than a free-form provider choice.", "The router removes ineligible or unhealthy executors.", "It ranks remaining candidates deterministically using configured utility and limits.", "The runtime dispatches through the chosen adapter, accounts usage, and stores the decision evidence.", "Fresh policy and lifecycle checks run again at sensitive dispatch boundaries."],
    interfaces: [artifact("Router task spec", "Tenant, capabilities, tools, region, data class, risk, quality, latency, and budget."), artifact("Executor descriptor", "Kind, identity, capabilities, price, limits, health, and policy metadata."), artifact("Router dispatch", "Selected executor and immutable decision evidence."), configuration("Provider registry", "Enabled providers, endpoints, credentials, prices, and model policies.")],
    evidence: [evidence("Router policy and ranking", "packages/platform/src/router.test.ts"), evidence("Durable runtime evidence", "packages/platform/src/router-runtime.test.ts"), evidence("Model provider adapters", "packages/agent/src/model-providers.test.ts")],
    guardrails: ["Callers cannot bypass tenant, risk, region, tool, or data-classification policy.", "Fallback never broadens authority.", "Provider credentials are not serialized into routing evidence.", "Spend is reserved and settled through the runtime accounting boundary."],
    limitations: ["The repository does not commit a universal production executor registry; availability depends on deployment secrets and approvals.", "Quality scores and prices are configuration evidence, not independent guarantees.", "The router selects and authorizes execution; it is not itself a model."],
    related: ["post-trained-models", "learning-system", "billing-usage", "fettler"],
  }),
  page({
    slug: "post-trained-models",
    title: "Post-trained models",
    category: "AI platform",
    summary: "Govern external adapter training, evaluation, consent, canary admission, routing, monitoring, and rollback as one evidence-bound lifecycle.",
    status: "preview",
    statusLabel: "Configured integration preview",
    availability: "Implemented control plane; no first-party trainer or shipped Mendpoint-trained model",
    startHere: { intro: "Enable the advanced AI application surface only after an approved external trainer, dataset consent, receipt authority, and signing evidence are configured.", steps: ["Seal an eligible consented corpus export.", "Submit an idempotent training job under a durable worker lease.", "Verify the authenticated trainer receipt and adapter artifact.", "Register the exact lifecycle, evaluations, canary evidence, monitoring, and rollback target.", "Admit the adapter to the model router only while fresh authority remains valid."] },
    capabilities: ["Durable single-dispatch external training jobs with leases and authenticated receipts", "Canonical adapter artifact hashing and exact training-to-registration binding", "Consent, held-out evaluation, canary, infrastructure, approval, monitoring, and rollback lifecycle", "Fresh pre-dispatch revocation and consent checks", "Router admission as an adapter executor"],
    useWhen: ["A tenant has a governed corpus and approved external trainer.", "An adapter must be evaluated and monitored before routing.", "Consent withdrawal or rollback must stop dispatch immediately."],
    howItWorks: ["Eligible redacted records produce a sealed dataset lineage artifact.", "One leased worker submits the exact training request and reconciles an authenticated receipt.", "The returned artifact is bound to dataset, adapter, base model, evaluation, and canary evidence.", "Lifecycle authority moves through registered, evaluated, canary, promoted, monitored, rolled-back, and retired states.", "The router rechecks current consent and lifecycle immediately before dispatch."],
    interfaces: [api("POST /advanced-ai/post-trained/training-jobs", "Run or reconcile an external training job when enabled."), api("POST /advanced-ai/post-trained/evaluations", "Evaluate an exact candidate against a disjoint holdout through an independent authority."), api("POST /advanced-ai/post-trained/canaries", "Run an evidence-bound shadow or bounded canary."), api("POST /advanced-ai/post-trained/adapters", "Register an exact completed adapter lifecycle after human approval."), api("POST /advanced-ai/post-trained/adapters/:adapterId/route-dry-run", "Evaluate router eligibility without invoking a model."), api("POST /advanced-ai/post-trained/adapters/:adapterId/rollback", "Remove a bound adapter from eligibility under human rollback authority."), artifact("Authenticated trainer receipt", "Job, request, artifact, evaluation, canary, and receipt MAC binding.")],
    evidence: [evidence("Training execution", "packages/pipeline/src/post-trained-training.test.ts"), evidence("Lifecycle registration", "packages/pipeline/src/post-trained-application.test.ts"), evidence("Router admission", "packages/platform/src/post-trained-runtime.test.ts")],
    guardrails: ["Training requires active dataset consent and explicit external-processing authority.", "Concurrent workers cannot dispatch the same training job twice.", "Evaluation and canary claims must exactly match the durable completion event.", "Rollback, revocation, expired consent, or stale monitoring blocks routing."],
    limitations: ["Mendpoint does not ship a trainer, model weights, or a post-trained production endpoint in this repository.", "The surface requires MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED and complete external authority.", "A production-shaped lifecycle is not evidence that a model has been trained or deployed."],
    related: ["model-router", "learning-system", "verification-attestations"],
  }),
  page({
    slug: "learning-system",
    title: "Learning system",
    category: "AI platform",
    summary: "Capture reviewed outcomes as consented, redacted, lineage-bound evidence for evaluation, ranking, and optional external training.",
    status: "preview",
    statusLabel: "Governed learning preview",
    availability: "Capture and corpus export implemented; downstream training requires separate authorization",
    startHere: { intro: "Record one approved outcome with explicit tenant consent, residency, retention, and source lineage.", steps: ["Capture the reviewed candidate and outcome metadata.", "Apply redaction, consent, temporal cutoff, and residency eligibility.", "Seal an immutable corpus export for one declared purpose.", "Use the export for evaluation or a separately authorized training job."] },
    capabilities: ["Human-reviewed Fettler and Regauge outcome capture", "Consent, residency, temporal cutoff, redaction, and lineage gates", "Deterministic sealed corpus exports", "Suppression and rejection evidence", "Graph and router outcome feedback"],
    useWhen: ["A reviewed migration should improve future ranking or evaluation.", "A tenant has explicitly consented to a defined learning purpose.", "An external training job needs an exact eligible dataset lineage."],
    howItWorks: ["The capture layer records approved metadata, evidence references, outcomes, and policy context.", "Eligibility excludes unconsented, stale, residency-conflicting, unredacted, or incomplete rows.", "The exporter orders and seals the eligible corpus under a purpose and cutoff.", "Consumers receive metadata and approved redacted content only; raw secrets and unrestricted repository data are excluded."],
    interfaces: [api("POST /advanced-ai/learning/consents", "Grant purpose-specific tenant learning consent."), api("POST /advanced-ai/learning/consents/:consentId/revoke", "Revoke one exact learning grant for future processing."), api("GET /advanced-ai/learning/status", "Read tenant-scoped learning, dataset, training, evaluation, canary, and adapter counts."), api("POST /advanced-ai/learning/corpora", "Seal eligible lessons and materialize deterministic train, validation, and holdout artifacts."), command("npm run learning:export-corpus", "Export the earlier compatibility corpus format."), artifact("Learning capture", "Outcome, consent, lineage, policy, and evidence references."), artifact("Sealed corpus", "Purpose-bound deterministic eligible dataset with a split manifest.")],
    evidence: [evidence("Learning capture", "packages/db/src/learning.test.ts"), evidence("Corpus eligibility", "packages/db/src/learning-corpus.test.ts"), evidence("Regauge learning loop", "apps/worker/src/transformer-learning.test.ts")],
    guardrails: ["No record is eligible without active consent and purpose authority.", "Redaction and lineage checks run before export.", "Temporal cutoffs prevent future outcome leakage into historical evaluation.", "Export does not invoke a trainer or model."],
    limitations: ["Corpus size and outcome diversity depend on real reviewed migrations.", "The current corpus does not imply a trained or promoted adapter.", "Learning activation and external processing remain tenant-specific."],
    related: ["post-trained-models", "model-router", "security-governance"],
  }),
  page({
    slug: "billing-usage",
    title: "Billing and usage",
    category: "Operations",
    summary: "Authorize plans and entitlements, reserve bounded spend before work, and settle exact usage with durable evidence.",
    status: "internal",
    statusLabel: "Internal commercial control",
    availability: "Usage accounting active in runtimes; public payment collection and standard invoicing are not active",
    startHere: { intro: "Assign the tenant an approved plan and entitlement before starting model or migration work.", steps: ["Create or select a versioned price plan.", "Grant the tenant a bounded entitlement.", "Reserve model, tool, or campaign usage before dispatch.", "Settle or release the reservation with exact receipt evidence."] },
    capabilities: ["Versioned plans and price definitions", "Tenant entitlements and quotas", "Idempotent usage reservations, settlement, release, and evidence", "Model token, cost, response-byte, and campaign budget accounting", "Gross-margin and execution-cost reporting"],
    useWhen: ["A workflow must fail before exceeding tenant authority.", "A provider call needs exact reserve and settle semantics.", "Operations needs attributable usage and cost evidence."],
    howItWorks: ["Tenant plan and entitlement authority define allowed units and limits.", "A runtime reserves the maximum bounded amount before an external effect.", "Completion settles the exact measured amount; cancellation releases the reservation.", "Idempotency and evidence prevent duplicate charges across response loss or takeover."],
    interfaces: [api("GET /billing/plans", "List configured product plans."), api("GET /billing/usage", "Read tenant usage."), api("POST /billing/usage/reservations", "Reserve bounded usage."), api("POST /billing/usage/reservations/:id/settle", "Settle exact measured usage."), api("POST /billing/usage/reservations/:id/release", "Release unused authority.")],
    evidence: [evidence("Billing domain", "packages/billing/src/usage-evidence.test.ts"), evidence("API plan control", "apps/api/src/billing-plan-control.test.ts"), evidence("Model accounting", "apps/worker/src/warden-model-accounting.test.ts")],
    guardrails: ["No external model spend is authorized without a successful reservation where accounting is required.", "Settlement cannot exceed authority or replay with different bytes.", "Tenant usage and evidence are isolated."],
    limitations: ["No public card checkout, subscription charging, or standard invoice flow is active.", "Private pilot commercial terms are agreed case by case.", "Configured prices are internal authority, not a public price list."],
    related: ["model-router", "fettler", "regauge", "security-governance"],
  }),
  page({
    slug: "security-governance",
    title: "Security and governance",
    category: "Trust and verification",
    summary: "Bind every sensitive operation to tenant identity, least-privilege authority, immutable evidence, human approvals, and revocable policy.",
    status: "limited_availability",
    statusLabel: "Profile-specific pilot controls",
    availability: "Private preview deployments with profile-specific authentication, encryption, and governance controls",
    startHere: { intro: "Run the deployment preflight, bootstrap one owner authority, and configure the narrowest repository, model, and delivery permissions required.", steps: ["Select the exact deployment profile.", "Configure encryption, authentication, tenant, repository, and egress authority.", "Bootstrap and rotate scoped API keys or SSO bindings.", "Verify readiness, audit, backup, revocation, and incident procedures before customer access."] },
    capabilities: ["Tenant-scoped API keys, RBAC, memberships, and trust principals", "GitHub account, installation, and repository binding", "Per-record encryption, checkpoint encryption, domain-separated keys, and cryptographic erasure", "Human review, waiver, escalation, production delivery, and policy gates", "Append-only audit and domain events with governed export", "SAML and OIDC integration surfaces"],
    useWhen: ["A deployment handles private repositories or model egress.", "An operator needs attributable approvals and revocation.", "A tenant requires bounded data retention and audit export."],
    howItWorks: ["Authentication resolves a durable principal and tenant before route authority.", "RBAC and domain-specific gates authorize the exact action and scope.", "Sensitive data is encrypted at rest and excluded from logs and public evidence.", "Every transition records immutable evidence and rechecks stale or revoked authority at effect boundaries.", "Readiness fails closed when profile-required controls are absent."],
    interfaces: [api("GET /keys", "List scoped API keys without returning secret values."), api("POST /keys", "Create a scoped key."), api("POST /keys/:id/revoke", "Revoke a key."), api("GET /audit", "Read tenant audit events."), api("GET /audit/export", "Export governed audit evidence."), configuration("Deployment profile", "Fail-closed environment contract for each runtime role.")],
    evidence: [evidence("Authentication and RBAC", "apps/api/src/auth.test.ts"), evidence("Tenant isolation", "packages/db/src/provider-tenant-isolation.test.ts"), evidence("Customer profile", "scripts/customer-warden-profile.test.ts"), evidence("Design partner encryption", "apps/api/src/design-partner-applications-store.test.ts")],
    guardrails: ["Tenant identity comes from authenticated authority, never request body claims.", "Secrets are not returned by list APIs or serialized into evidence.", "Human approval never grants merge or deployment capability.", "Profile-required missing authority stops startup rather than falling back."],
    limitations: ["Security posture depends on correct deployment secrets, network policy, and operator procedures.", "High availability differs by profile; the current dedicated Regauge coordinator is single-authority.", "External providers and SCM integrations create egress only when explicitly configured."],
    related: ["repository-connections", "verification-attestations", "deployment-operations"],
  }),
  page({
    slug: "deployment-operations",
    title: "Deployment and operations",
    category: "Operations",
    summary: "Run Mendpoint with role-specific readiness, durable state, recovery controls, audit evidence, backups, and bounded rollout procedures.",
    status: "limited_availability",
    statusLabel: "Pilot evaluation",
    availability: "Docker Compose and Fly pilot deployment; the dedicated Regauge profile is implemented but no live Regauge deployment is claimed",
    startHere: { intro: "Choose the Fettler, Regauge pilot, demo, or self-hosted profile and satisfy its complete startup contract before deployment.", steps: ["Validate the exact configuration and secret names without exposing values.", "Build and boot the production image against an existing-state database.", "Deploy one canary instance and verify liveness, readiness, storage, integrations, and rollback.", "Scale only after crash, response-loss, stale-fence, and restore drills pass."] },
    capabilities: ["Docker multi-stage images for API, web, worker, all-in-one Fly, and dedicated Regauge roles", "Fly Fettler production and dedicated Regauge coordinator/worker manifests", "Liveness, readiness, worker heartbeat, alerts, metrics, trajectories, and recovery summary", "Encrypted backup, restore, backup fencing, snapshots, disaster-recovery drill, and image rollback", "Lease-fenced jobs and checkpointed Fettler and Regauge execution"],
    useWhen: ["An operator is preparing a new pilot environment.", "A release changes persistence, jobs, external effects, or readiness.", "A worker or process must be replaced without duplicating work."],
    howItWorks: ["Profile validation turns configuration into an explicit authority contract.", "Durable coordinators own leases and state; workers operate only under current fences.", "Health endpoints separate process liveness from dependency readiness.", "Deployments proceed through tests, production build, container smoke, canary, live checks, and recorded rollback.", "Backups and terminal evidence retain recovery and audit authority."],
    interfaces: [command("npm run ga:check", "Run specification, claim, action-pin, and GA checks."), command("npm run e2e:deployment", "Run the production deployment journey and crash recovery."), command("npm run dr:drill", "Exercise disaster recovery."), api("GET /live", "API process liveness."), api("GET /ready", "API dependency readiness."), api("GET /health", "Detailed runtime health."), configuration("fly.transformer.toml", "Separate coordinator and stateless worker production pilot.")],
    evidence: [evidence("Deployment E2E", "tests/e2e/deployment.spec.ts"), evidence("Readiness", "packages/ops/src/readiness.test.ts"), evidence("Backup and restore", "packages/ops/src/disaster-recovery.test.ts"), evidence("Regauge profile contract", "apps/worker/src/transformer-production-profile.test.ts")],
    guardrails: ["A release is not complete until exact commit, image, health, and rollback evidence agree.", "Schema changes must boot against both fresh and pre-change databases.", "Coordinator and worker identities, storage, and fences must remain distinct across scale-out.", "Stopping workers preserves coordinator, volume, and immutable artifacts for evidence."],
    limitations: ["Optional model and source control integrations can create network egress", "High availability and enterprise support are not included", "The hosted Fettler profile is a single Fly application, not a multi-region high-availability control plane.", "No dedicated Regauge deployment is claimed live until its app, secrets, volume, health, and canary evidence are independently verified."],
    related: ["security-governance", "billing-usage", "fettler", "regauge"],
  }),
]);

export function findProductDoc(slug: string): ProductDoc | undefined {
  return PRODUCT_DOCS.find((page) => page.slug === slug);
}

export function docsByCategory(): readonly Readonly<{ category: DocCategory; pages: readonly ProductDoc[] }>[] {
  return DOC_CATEGORIES.map((category) => Object.freeze({
    category,
    pages: Object.freeze(PRODUCT_DOCS.filter((page) => page.category === category)),
  }));
}

export function buildDocsManifest() {
  return Object.freeze({
    schemaVersion: "2026-08-14.v1" as const,
    generatedFrom: "apps/web/app/docs/catalog.ts",
    pages: Object.freeze(PRODUCT_DOCS.map((page) => Object.freeze({
      slug: page.slug,
      title: page.title,
      category: page.category,
      status: page.status,
      statusLabel: page.statusLabel,
      availability: page.availability,
      lastVerified: page.lastVerified,
      webPath: `/docs/${page.slug}`,
      markdownPath: `./${page.slug}.md`,
    }))),
  });
}

export function renderProductDocMarkdown(page: ProductDoc): string {
  const lines = [
    `# ${page.title}`,
    "",
    page.summary,
    "",
    `Status: ${page.statusLabel}`,
    `Availability: ${page.availability}`,
    `Last verified: ${page.lastVerified}`,
    "",
    "## Start here",
    "",
    page.startHere.intro,
    "",
    ...page.startHere.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (page.startHere.command) lines.push("", "```sh", page.startHere.command, "```");
  lines.push(
    "", "## What it does", "", ...page.capabilities.map((value) => `- ${value}`),
    "", "## When to use it", "", ...page.useWhen.map((value) => `- ${value}`),
    "", "## How it works", "", ...page.howItWorks.map((value, index) => `${index + 1}. ${value}`),
    "", "## Interfaces", "", "| Name | Kind | Description |", "| --- | --- | --- |",
    ...page.interfaces.map((item) => `| ${escapeTable(item.name)} | ${item.kind} | ${escapeTable(item.detail)} |`),
    "", "## Evidence and verification", "", ...page.evidence.map((item) => `- ${item.label}: \`${item.locator}\``),
    "", "## Safety model", "", ...page.guardrails.map((value) => `- ${value}`),
    "", "## Limitations", "", ...page.limitations.map((value) => `- ${value}`),
    "", "## See also", "", ...page.related.map((slug) => `- [${findProductDoc(slug)?.title ?? slug}](./${slug}.md)`),
    "",
  );
  return lines.join("\n");
}

function page(input: Omit<ProductDoc, "lastVerified"> & Partial<Pick<ProductDoc, "lastVerified">>): ProductDoc {
  return deepFreeze({ ...input, lastVerified: input.lastVerified ?? verified }) as ProductDoc;
}

function api(name: string, detail: string) { return Object.freeze({ name, kind: "API" as const, detail }); }
function command(name: string, detail: string) { return Object.freeze({ name, kind: "Command" as const, detail }); }
function event(name: string, detail: string) { return Object.freeze({ name, kind: "Event" as const, detail }); }
function configuration(name: string, detail: string) { return Object.freeze({ name, kind: "Configuration" as const, detail }); }
function artifact(name: string, detail: string) { return Object.freeze({ name, kind: "Artifact" as const, detail }); }
function evidence(label: string, locator: string) { return Object.freeze({ label, locator }); }
function escapeTable(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
