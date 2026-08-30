import { assertPublicDocsApiRoute } from "@mendpoint/contract";

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
export type DocPublicationEvidence =
  | Readonly<{ state: "not_live"; deployedRevision: null; evidenceDigest: null }>
  | Readonly<{ state: "live"; deployedRevision: string; evidenceDigest: string }>;

export type ProductDoc = Readonly<{
  slug: string;
  title: string;
  category: DocCategory;
  summary: string;
  status: DocStatus;
  statusLabel: string;
  availability: string;
  lastVerified: string;
  publicationEvidence: DocPublicationEvidence;
  startHere: Readonly<{ intro: string; steps: readonly string[]; command?: string }>;
  capabilities: readonly string[];
  useWhen: readonly string[];
  howItWorks: readonly string[];
  interfaces: readonly Readonly<{ name: string; kind: "API" | "Command" | "Event" | "Configuration" | "Artifact"; detail: string }> [];
  evidence: readonly Readonly<{ label: string; locator: string }> [];
  guardrails: readonly string[];
  limitations: readonly string[];
  related: readonly string[];
  requirementIds: readonly string[];
  claimIds: readonly string[];
  sourceContracts: readonly string[];
}>;

type DocAuthority = Readonly<{
  requirementIds: readonly string[];
  claimIds: readonly string[];
  sourceContracts: readonly string[];
}>;

const DOC_AUTHORITY: Readonly<Record<string, DocAuthority>> = deepFreeze({
  fettler: authority(["ME-ING-001", "ME-ING-002", "ME-ING-009", "ME-SCM-003", "ME-WAR-001", "ME-WAR-002", "ME-WAR-003", "ME-WAR-004", "ME-WAR-005", "ME-WAR-006", "ME-WAR-007", "ME-WAR-008", "ME-WAR-009", "ME-GTM-001", "ME-GTM-002"], ["CLM-002", "CLM-004", "CLM-005", "CLM-006"], ["apps/api/src/server.ts", "packages/agent/src/agent.ts", "apps/worker/src/cli.ts"]),
  regauge: authority(["ME-TRN-001", "ME-TRN-002", "ME-TRN-003", "ME-TRN-004", "ME-TRN-005", "ME-TRN-006", "ME-TRN-007", "ME-TRN-008", "ME-TRN-009", "ME-TRN-010", "ME-TRN-011", "ME-TRN-012", "ME-TRN-013"], ["CLM-007"], ["apps/api/src/regauge-production-bootstrap.ts", "apps/api/src/regauge-plan-consult.ts", "apps/worker/src/regauge-mission-task-claim.ts"]),
  "change-ingestion": authority(["ME-ING-001", "ME-ING-002", "ME-ING-003", "ME-ING-004", "ME-ING-005", "ME-ING-006", "ME-ING-007", "ME-ING-008", "ME-ING-009"], [], ["packages/change-intel/src/index.ts", "packages/catalog/src/index.ts", "apps/api/src/server.ts"]),
  "change-graph": authority(["ME-GRF-001", "ME-GRF-002", "ME-GRF-003", "ME-GRF-004", "ME-GRF-005", "ME-GRF-006", "ME-GRF-007", "ME-GRF-008", "ME-WAR-001"], ["CLM-003"], ["packages/graph/src/index.ts", "packages/graph-learn/src/store.ts", "apps/api/src/server.ts"]),
  "repository-connections": authority(["ME-SCM-001", "ME-SCM-002", "ME-SCM-003", "ME-SCM-004", "ME-SCM-005", "ME-SCM-006"], ["CLM-008"], ["apps/api/src/repository-connections.ts", "packages/github/src/index.ts", "packages/platform/src/repository-source.ts"]),
  "draft-delivery": authority(["ME-SCM-003", "ME-SCM-004", "ME-WAR-003", "ME-WAR-004"], ["CLM-006", "CLM-008"], ["packages/github/src/index.ts", "apps/worker/src/fettler-pr-review-dispatch.ts", "apps/api/src/server.ts"]),
  "verification-attestations": authority(["ME-WAR-002", "ME-WAR-003", "ME-WAR-005", "ME-RTR-005"], ["CLM-005"], ["packages/repair/src/verify.ts", "packages/db/src/mission-verification.ts", "apps/api/src/advanced-ai-applications.ts"]),
  "model-router": authority(["ME-RTR-001", "ME-RTR-002", "ME-RTR-003", "ME-RTR-004", "ME-RTR-005", "ME-RTR-006", "ME-RTR-009"], [], ["packages/platform/src/router.ts", "packages/platform/src/router-runtime.ts", "apps/worker/src/cli.ts"]),
  "post-trained-models": authority(["ME-FND-004", "ME-RTR-007", "ME-RTR-008", "ME-RTR-009"], [], ["packages/platform/src/adapter-lifecycle.ts", "apps/api/src/advanced-ai-applications.ts"]),
  "learning-system": authority(["ME-FND-009", "ME-RTR-006", "ME-RTR-007"], [], ["packages/db/src/learning.ts", "packages/db/src/organization-memory.ts", "apps/api/src/learning-consent-routes.ts"]),
  "billing-usage": authority(["ME-FND-008", "ME-COM-001", "ME-COM-002", "ME-COM-003", "ME-COM-004"], [], ["packages/db/src/usage.ts", "apps/api/src/billing-economics.ts", "apps/api/src/server.ts"]),
  "security-governance": authority(["ME-GTM-001", "ME-ENT-001", "ME-ENT-002", "ME-ENT-003", "ME-ENT-004", "ME-WAR-008"], ["CLM-014"], ["apps/api/src/auth.ts", "packages/contract/src/tenant-boundary.ts", "packages/contract/src/audit-governance.ts"]),
  "deployment-operations": authority(["ME-FND-005", "ME-ENT-005", "ME-ENT-006", "ME-ENT-007", "ME-ENT-008", "ME-ENT-009", "ME-ENT-010", "ME-ENT-011", "ME-ENT-012"], ["CLM-009", "CLM-013"], ["scripts/start-fly.mjs", "packages/ops/src/readiness.ts", "packages/ops/src/disaster-recovery.ts"]),
  "authentication-tenancy": authority(["ME-ENT-001", "ME-ENT-002", "ME-ENT-003"], [], ["apps/api/src/auth.ts", "apps/api/src/tenant-memberships.ts", "packages/contract/src/tenant-boundary.ts"]),
  "mission-policy": authority(["ME-WAR-005", "ME-TRN-003", "ME-TRN-007", "ME-TRN-009"], [], ["packages/db/src/mission.ts", "packages/db/src/mission-task.ts", "packages/db/src/policy-envelope.ts"]),
  "api-conventions": authority(["ME-FND-007", "ME-ENT-001", "ME-ENT-002", "ME-WAR-008"], [], ["apps/api/src/auth.ts", "apps/api/src/production.ts", "apps/api/src/error-boundary.ts"]),
  "webhooks-events": authority(["ME-SCM-003", "ME-SCM-004", "ME-WAR-004", "ME-WAR-008"], [], ["apps/api/src/server.ts", "apps/api/src/fettler-pr-review-webhook.ts", "apps/api/src/delivery-outcome-learning-dispatch.ts"]),
  "audit-compliance": authority(["ME-WAR-008", "ME-ENT-004", "ME-ENT-012"], [], ["packages/contract/src/audit-governance.ts", "apps/api/src/audit-export.ts", "packages/db/src/change-impact-audit.ts"]),
  "recovery-reliability": authority(["ME-ENT-005", "ME-ENT-006", "ME-ENT-007", "ME-ENT-008", "ME-ENT-009", "ME-ENT-010"], [], ["packages/ops/src/readiness.ts", "packages/ops/src/disaster-recovery.ts", "scripts/customer-restore.ts"]),
  "limits-errors": authority(["ME-FND-006", "ME-FND-007", "ME-ENT-005", "ME-ENT-009"], [], ["apps/api/src/production.ts", "apps/api/src/error-boundary.ts", "docs/PERFORMANCE_CONTRACT.md"]),
});

const verified = "2026-08-14";
const notLivePublicationEvidence: DocPublicationEvidence = deepFreeze({
  state: "not_live",
  deployedRevision: null,
  evidenceDigest: null,
});

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
    title: "ReGauge — the first AI Legacy Engineer",
    category: "Specialist agents",
    summary: "ReGauge is an experimental planning preview.",
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
    interfaces: [api("POST /transformer/missions", "Plan a repository-backed migration mission."), api("POST /transformer/control-plane/campaigns/:campaignId/review", "Record independent blueprint review."), api("GET /transformer/control-plane/campaigns/:campaignId", "Inspect campaign and execution state."), command("npm run eval:transformer:canary", "Run the deterministic ReGauge canary."), configuration("MENDPOINT_REGAUGE_GATE", "Tenant, environment, boundary, and production-delivery authority.")],
    evidence: [evidence("Mission planning and compilation", "packages/transformer/src/mission-planner.test.ts"), evidence("Pilot execution and checkpoints", "packages/transformer/src/pilot-execution.test.ts"), evidence("Multi-node worker", "apps/worker/src/transformer-multinode-service.test.ts")],
    guardrails: ["Blueprint planner and approving reviewer must be independent authorized principals.", "Planning cannot widen paths, recipe scope, budgets, or source authority.", "Stale or mismatched source evidence fails closed.", "Preview access does not grant repository mutation or delivery authority."],
    limitations: ["Repository execution and staged pull request campaigns are not customer ready", "No dedicated ReGauge deployment is claimed live.", "Adaptive model planning and legacy extraction use separate gates and are not implied by the planning preview."],
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
    interfaces: [api("POST /providers/:slug/versions", "Store a versioned provider schema."), api("POST /providers/:slug/publish-version", "Publish and classify a version."), api("POST /feeds/poll", "Poll configured feeds."), api("POST /graphql/schemas/:sourceKey/versions", "Store and diff GraphQL SDL or introspection when enabled."), api("POST /change-sources", "Submit reviewed manual change evidence when enabled.")],
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
    useWhen: ["Fettler or ReGauge needs authoritative source bytes.", "A repository must be read without storing a long-lived user token.", "A later worker must reconstruct the exact prior source state."],
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
    interfaces: [configuration("Repository verification profile", "Approved commands, bounds, environment, and waiver authority."), artifact("Verification evidence", "Command, result, output digests, and source/candidate binding."), api("POST /advanced-ai/attestations", "Issue an attestation when advanced AI applications are enabled."), api("GET /advanced-ai/attestations/:attestationId", "Retrieve and verify stored attestation evidence.")],
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
    startHere: { intro: "Register only approved executors, then route a structured task under tenant risk, data, region, quality, latency, and budget policy.", steps: ["Create an executor registry with immutable descriptors.", "Define the tenant task and routing policy.", "Resolve the ranked eligible candidates.", "Dispatch through the selected executor and return the immutable routing decision, cost, and outcome."] },
    capabilities: ["Eligibility filtering by tenant, capability, tool, region, data classification, risk, cost, latency, and health", "Deterministic ranking with recipe preference when requirements match", "Circuit breakers, bounded retries, policy-bound fallback, and human handoff", "OpenAI, Anthropic, Gemini, xAI, Muse Spark, and OpenAI-compatible provider adapters", "Immutable per-decision routing and provider provenance record"],
    useWhen: ["A specialist workflow needs model or recipe selection under policy.", "A tenant needs region, privacy, cost, or risk constraints.", "A provider failure should fall back only to another explicitly authorized executor."],
    howItWorks: ["The caller submits a structured task spec rather than a free-form provider choice.", "The router removes ineligible or unhealthy executors.", "It ranks remaining candidates deterministically using configured utility and limits.", "The runtime dispatches through the chosen adapter, accounts usage, and returns the immutable decision record.", "Fresh policy and lifecycle checks run again at sensitive dispatch boundaries."],
    interfaces: [artifact("Router task spec", "Tenant, capabilities, tools, region, data class, risk, quality, latency, and budget."), artifact("Executor descriptor", "Kind, identity, capabilities, price, limits, health, and policy metadata."), artifact("Router dispatch", "Selected executor and immutable decision evidence."), configuration("Provider registry", "Enabled providers, endpoints, credentials, prices, and model policies.")],
    evidence: [evidence("Router policy and ranking", "packages/platform/src/router.test.ts"), evidence("Model provider adapters", "packages/agent/src/model-providers.test.ts")],
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
    capabilities: ["Human-reviewed Fettler and ReGauge outcome capture", "Consent, residency, temporal cutoff, redaction, and lineage gates", "Deterministic sealed corpus exports", "Suppression and rejection evidence", "Graph and router outcome feedback"],
    useWhen: ["A reviewed migration should improve future ranking or evaluation.", "A tenant has explicitly consented to a defined learning purpose.", "An external training job needs an exact eligible dataset lineage."],
    howItWorks: ["The capture layer records approved metadata, evidence references, outcomes, and policy context.", "Eligibility excludes unconsented, stale, residency-conflicting, unredacted, or incomplete rows.", "The exporter orders and seals the eligible corpus under a purpose and cutoff.", "Consumers receive metadata and approved redacted content only; raw secrets and unrestricted repository data are excluded."],
    interfaces: [api("POST /advanced-ai/learning/consents", "Grant purpose-specific tenant learning consent."), api("POST /advanced-ai/learning/consents/:consentId/revoke", "Revoke one exact learning grant for future processing."), api("GET /advanced-ai/learning/status", "Read tenant-scoped learning, dataset, training, evaluation, canary, and adapter counts."), api("POST /advanced-ai/learning/corpora", "Seal eligible lessons and materialize deterministic train, validation, and holdout artifacts."), command("npm run learning:export-corpus", "Export the earlier compatibility corpus format."), artifact("Learning capture", "Outcome, consent, lineage, policy, and evidence references."), artifact("Sealed corpus", "Purpose-bound deterministic eligible dataset with a split manifest.")],
    evidence: [evidence("Learning capture", "packages/db/src/learning.test.ts"), evidence("Corpus eligibility", "packages/db/src/learning-corpus.test.ts"), evidence("ReGauge learning loop", "apps/worker/src/transformer-learning.test.ts")],
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
    evidence: [evidence("Usage ledger domain", "packages/db/src/usage.test.ts"), evidence("API plan control", "apps/api/src/billing-plan-control.test.ts"), evidence("Model accounting", "apps/worker/src/warden-model-accounting.test.ts")],
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
    howItWorks: ["Authentication resolves a durable principal and tenant before route authority.", "RBAC and domain-specific gates authorize the exact action and scope.", "Sensitive data is encrypted at rest and excluded from logs and public evidence.", "Every transition records attributable evidence under the authority implemented by that route.", "Readiness fails closed when profile-required controls are absent."],
    interfaces: [api("GET /keys", "List scoped API keys without returning secret values."), api("POST /keys", "Create a scoped key."), api("POST /keys/:id/revoke", "Revoke a key."), api("GET /audit", "Read tenant audit events."), api("GET /audit/export", "Export governed audit evidence."), configuration("Deployment profile", "Fail-closed environment contract for each runtime role.")],
    evidence: [evidence("Authentication and RBAC", "apps/api/src/auth.test.ts"), evidence("Tenant isolation", "packages/db/src/provider-tenant-isolation.test.ts"), evidence("Customer profile", "scripts/customer-warden-profile.test.ts"), evidence("Design partner encryption", "apps/api/src/design-partner-applications-store.test.ts")],
    guardrails: ["Tenant identity comes from authenticated authority, never request body claims.", "Secrets are not returned by list APIs or serialized into evidence.", "Human approval never grants merge or deployment capability.", "Profile-required missing authority stops startup rather than falling back."],
    limitations: ["Security posture depends on correct deployment secrets, network policy, and operator procedures.", "High availability differs by profile; a dedicated ReGauge coordinator is single-authority when deployed.", "External providers and SCM integrations create egress only when explicitly configured."],
    related: ["repository-connections", "verification-attestations", "deployment-operations"],
  }),
  page({
    slug: "authentication-tenancy",
    title: "Authentication and tenancy",
    category: "Trust and verification",
    summary: "Authenticate one durable principal, derive its tenant from protected authority, and authorize the exact requested capability.",
    status: "limited_availability",
    statusLabel: "Profile specific controls",
    availability: "Scoped API key authentication is active; enterprise identity integrations require separately configured authority",
    lastVerified: "2026-08-30",
    startHere: { intro: "Create a tenant scoped credential through an authenticated administrator and keep its secret outside source control.", steps: ["Select the tenant and least privileged role.", "Create the credential and capture its value once through the protected operator path.", "Send it as a Bearer token over HTTPS.", "Rotate or revoke it and verify that later requests fail closed."], command: "curl -H \"Authorization: Bearer $MENDPOINT_API_KEY\" https://your-mendpoint.example/ready" },
    capabilities: ["Tenant scoped API key authentication", "Durable principals, memberships, roles, expiry, and revocation", "Request identity and audit attribution", "Service principal and enterprise identity contracts"],
    useWhen: ["A human or service needs access to a protected Mendpoint API.", "An operator must rotate or revoke access without changing tenant data."],
    howItWorks: ["The authentication middleware resolves the credential to one durable principal and tenant.", "Membership and role checks authorize the exact route capability.", "Mutation routes apply the authority checks implemented at their declared boundary.", "Audit records retain principal, credential, tenant, and request identity without storing the secret."],
    interfaces: [api("GET /keys", "List credential metadata without secret material."), api("POST /keys", "Create a scoped credential through tenant administration authority."), api("POST /keys/:id/revoke", "Revoke one credential."), api("GET /tenants", "List tenants visible to the authenticated principal."), api("POST /tenants/memberships", "Create a tenant membership when authorized.")],
    evidence: [evidence("Authentication middleware", "apps/api/src/auth.test.ts"), evidence("Membership lifecycle", "apps/api/src/tenant-memberships.test.ts"), evidence("Cross tenant denial", "apps/api/src/cross-tenant-denial.test.ts")],
    guardrails: ["Tenant identity never comes from a request body claim.", "Credential values are returned only at creation and are never listed.", "Expiry and revocation are rechecked before protected effects.", "Production credentials require HTTPS and must not follow redirects."],
    limitations: ["Tenant membership mutations in the current release authorize before body processing; effect-boundary revalidation is not claimed until its upgrade path ships.", "SAML and SCIM need an approved enterprise identity tenant for live qualification.", "Authentication availability depends on the selected deployment profile."],
    related: ["api-conventions", "security-governance", "audit-compliance"],
  }),
  page({
    slug: "mission-policy",
    title: "Mission and Policy Envelope",
    category: "AI platform",
    summary: "Persist durable work as tenant scoped Missions whose tasks inherit deterministic repository, model, review, residency, and delivery boundaries.",
    status: "internal",
    statusLabel: "Internal shared foundation",
    availability: "Durable Mission and Policy Envelope primitives are active behind product specific interfaces",
    lastVerified: "2026-08-30",
    startHere: { intro: "Create product work through Fettler or ReGauge so the product binds the Mission to its exact source and policy context.", steps: ["Create the product request under an authenticated tenant.", "Inspect the bound repository snapshot, graph projection, and Policy Envelope version.", "Run or hand off one Mission task under its current lease.", "Resolve exceptions and inspect the retained decision and artifact lineage."] },
    capabilities: ["Durable Missions, tasks, decisions, exceptions, and artifacts", "Versioned Policy Envelope inheritance", "Agent to human to agent handoff", "Restart and lease safe continuation", "Bounded MissionGraphProjection and context references"],
    useWhen: ["Work spans multiple steps, workers, or reviewers.", "A later operator must reconstruct the exact authority and evidence used by a task."],
    howItWorks: ["The product creates one tenant scoped Mission and binds its immutable source identities.", "Tasks inherit the exact Policy Envelope rather than reconstructing restrictions from a prompt.", "Workers claim tasks under leases and append idempotent outcomes.", "Handoffs, exceptions, and superseding decisions preserve lineage without storing hidden reasoning."],
    interfaces: [artifact("Mission", "Tenant, product, objective, state, and source bindings."), artifact("Mission task", "Lease, inputs, required capabilities, policy, and outcome."), artifact("Policy Envelope", "Versioned repository, tool, model, residency, risk, review, delivery, and learning boundaries."), event("Mission transition", "Idempotent state transition with actor and evidence lineage.")],
    evidence: [evidence("Mission persistence", "packages/db/src/mission.test.ts"), evidence("Mission task lifecycle", "packages/db/src/mission-task.test.ts"), evidence("Policy inheritance", "packages/db/src/policy-envelope.test.ts"), evidence("Handoff continuity", "packages/db/src/mission-handoff.test.ts")],
    guardrails: ["Every read and write is tenant scoped.", "A task cannot widen its inherited policy.", "Changed source, policy, graph, or authority makes prior execution eligibility stale.", "Context references record supplied evidence, not chain of thought."],
    limitations: ["Product routes expose only the Mission operations needed by that product.", "Mission persistence does not itself authorize repository mutation, delivery, merge, or deployment."],
    related: ["fettler", "regauge", "change-graph", "audit-compliance"],
  }),
  page({
    slug: "api-conventions",
    title: "API conventions",
    category: "Connect and deliver",
    summary: "Use consistent authentication, request identity, idempotency, error, and retry rules when integrating with Mendpoint APIs.",
    status: "limited_availability",
    statusLabel: "Route specific production contract",
    availability: "Documented behavior applies only where the referenced route implements the named convention",
    lastVerified: "2026-08-30",
    startHere: { intro: "Begin with a read request, then add one replay safe mutation using an exact idempotency key.", steps: ["Use HTTPS and a tenant scoped Bearer credential.", "Send Content Type application/json for JSON mutations.", "Supply X Request Id for traceability and Idempotency Key where the route requires it.", "Treat status, error code, and request ID as the failure contract."], command: "curl -H \"Authorization: Bearer $MENDPOINT_API_KEY\" -H \"X-Request-Id: example-request-1\" https://your-mendpoint.example/ready" },
    capabilities: ["Bearer authentication", "Caller supplied or generated request identity", "Route specific idempotent mutations", "Structured error codes", "Explicit overload retry guidance"],
    useWhen: ["A service calls Mendpoint directly.", "A caller must recover safely after response loss or worker takeover."],
    howItWorks: ["Authentication and tenant resolution run before protected routes.", "The request ID follows the operation into audit and failure responses.", "Mutation routes that require Idempotency Key bind it to the exact request fingerprint.", "Same key and same bytes can replay; same key and different bytes conflict.", "Retry only read operations, explicit overload responses, or exact replay safe mutations."],
    interfaces: [configuration("Authorization: Bearer <token>", "Tenant scoped API credential."), configuration("X-Request-Id", "Optional caller request identity returned or retained for diagnosis."), configuration("Idempotency-Key", "Required only on routes that declare replay safety."), artifact("Error response", "HTTP status plus a stable error code and request identity where the route provides it."), configuration("Retry-After", "Delay supplied by an overload response when present.")],
    evidence: [evidence("Authentication contract", "apps/api/src/auth.test.ts"), evidence("Request identity and overload", "apps/api/src/production.test.ts"), evidence("Error boundary", "apps/api/src/error-boundary.test.ts"), evidence("Idempotent application routes", "apps/api/src/advanced-ai-applications.test.ts")],
    guardrails: ["Never send a production credential over plain HTTP or through a redirect.", "Do not assume every mutation is idempotent; require an explicit route contract.", "Do not retry authorization, validation, or idempotency conflict responses without changing authority or input.", "List pagination is endpoint specific; absence of a cursor contract is not proof that an unbounded list is complete."],
    limitations: ["The API does not yet publish one complete OpenAPI document for every route.", "Pagination and rate limits are not uniform across all route groups."],
    related: ["authentication-tenancy", "webhooks-events", "limits-errors"],
  }),
  page({
    slug: "webhooks-events",
    title: "Webhooks and domain events",
    category: "Connect and deliver",
    summary: "Accept authenticated SCM events, deduplicate deliveries, derive tenant scope from durable bindings, and record replay safe domain outcomes.",
    status: "limited_availability",
    statusLabel: "GitHub production path",
    availability: "GitHub webhook ingestion is implemented; a customer ready GitLab webhook path is not active",
    lastVerified: "2026-08-30",
    startHere: { intro: "Configure the GitHub App webhook to the public callback and subscribe only to events required by enabled capabilities.", steps: ["Set the webhook URL to https://your-mendpoint.example/webhooks/github.", "Store the webhook secret in the protected deployment environment.", "Select pull request, pull request review, check, installation, and repository events required by the installation.", "Send a test event and verify one durable delivery record and one resulting domain transition."] },
    capabilities: ["GitHub signature verification", "Delivery identity deduplication", "Installation and repository authority resolution", "Pull request, review, check, installation, and repository reconciliation", "Outcome learning dispatch after durable delivery state"],
    useWhen: ["GitHub must update repository authority or pull request state.", "A response can be lost and the provider may redeliver the same event."],
    howItWorks: ["The public endpoint verifies the signature before reading event authority.", "The delivery ID is claimed once and duplicate deliveries adopt the retained result.", "Installation and repository identifiers resolve one authorized tenant binding.", "The handler commits domain state before dispatching follow up work.", "Provider comments and review text remain untrusted evidence and never authorize mutation by themselves."],
    interfaces: [api("POST /webhooks/github", "Receive a signed GitHub App delivery."), event("Webhook delivery", "Signature, provider delivery ID, event kind, state, and retained outcome."), event("Domain event", "Tenant scoped idempotent product transition derived from verified provider evidence.")],
    evidence: [evidence("Webhook route", "apps/api/src/server.ts"), evidence("Fettler review dispatch", "apps/api/src/fettler-pr-review-webhook.test.ts"), evidence("Connection round trip", "apps/api/src/repository-connect.test.ts"), evidence("Outcome deduplication", "apps/api/src/delivery-outcome-learning-dispatch.test.ts")],
    guardrails: ["Unsigned, stale, malformed, or unauthorized deliveries fail closed.", "The request body tenant is never trusted.", "Duplicate delivery is not duplicate work.", "Webhook evidence cannot merge, deploy, or widen candidate authority."],
    limitations: ["GitLab delivery is on the roadmap.", "Enabled event types depend on the installed GitHub App permissions and product profile."],
    related: ["repository-connections", "draft-delivery", "api-conventions", "audit-compliance"],
  }),
  page({
    slug: "audit-compliance",
    title: "Audit and compliance evidence",
    category: "Trust and verification",
    summary: "Retain tenant scoped, attributable, append only operational evidence and export only the governed fields a reviewer is authorized to inspect.",
    status: "internal",
    statusLabel: "Engineering evidence active",
    availability: "Audit capture and governed export are implemented; independent compliance assessment remains external",
    lastVerified: "2026-08-30",
    startHere: { intro: "Run one authenticated mutation and use its request identity to inspect the resulting audit record.", steps: ["Perform an authorized mutation with X Request Id.", "Read the tenant audit trail.", "Export the governed evidence set for the declared review purpose.", "Verify redaction, chain integrity, retention, and any legal hold before distribution."] },
    capabilities: ["Unified audit records across API and worker effects", "Principal, credential, tenant, request, and subject attribution", "Append only and tamper evident evidence contracts", "Governed redacted export", "Retention and legal hold policy contracts"],
    useWhen: ["A reviewer must reconstruct who authorized a sensitive transition.", "An operator must export evidence without exposing secrets or unrelated tenant data."],
    howItWorks: ["Sensitive actions append an audit record after authority is resolved.", "Records bind actor, tenant, request, subject, action, outcome, and evidence references.", "Export applies tenant scope, field policy, retention, and redaction.", "Independent legal and assessor artifacts remain separate external evidence."],
    interfaces: [api("GET /audit", "Read tenant scoped audit records."), api("GET /audit/export", "Export the governed tenant evidence set."), artifact("Audit chain", "Append only attributable transition records."), artifact("Compliance evidence package", "Engineering controls plus separately supplied legal and assessor evidence.")],
    evidence: [evidence("Audit governance contract", "packages/contract/src/audit-governance.test.ts"), evidence("Unified route audit", "apps/api/src/audit-unification.test.ts"), evidence("Governed export", "apps/api/src/audit-export.test.ts"), evidence("Database export", "packages/db/src/audit-export.test.ts")],
    guardrails: ["Audit reads and exports are tenant scoped.", "Secrets, raw credentials, hidden reasoning, and unauthorized content are excluded.", "Missing or unverifiable audit evidence is not converted to a successful claim.", "Code evidence cannot replace legal approval or independent assessment."],
    limitations: ["DPA, subprocessor, penetration test, and independent assessment evidence are externally owned.", "Retention and legal hold qualification depend on the deployed storage and approved policy."],
    related: ["security-governance", "authentication-tenancy", "recovery-reliability"],
  }),
  page({
    slug: "recovery-reliability",
    title: "Recovery and reliability",
    category: "Operations",
    summary: "Back up authenticated state, restore it under a bounded operator workflow, and prove readiness without repeating completed external work.",
    status: "internal",
    statusLabel: "Engineering controls only",
    availability: "Authenticated backup and restore primitives exist; current schema convergence, replay canaries, and cross region production recovery are not integrated",
    lastVerified: "2026-08-30",
    startHere: { intro: "Create an authenticated backup receipt before exercising recovery in an isolated target.", steps: ["Verify current backup authority and create one committed encrypted backup.", "Load and authenticate its exact recovery receipt.", "Restore only into the explicitly isolated target.", "Separately run current schema convergence, replay canaries, readiness, and rollback checks before considering cutover."] },
    capabilities: ["Encrypted committed backup manifests", "Authenticated recovery receipts", "Bounded restore orchestration", "Backup fencing", "Readiness, recovery summary, and disaster recovery drill primitives"],
    useWhen: ["A deployment must recover from storage or region loss.", "An upgrade must prove rollback and prior schema restore."],
    howItWorks: ["Backup captures the declared durable resources and signs the exact manifest identity.", "The restore command authenticates the receipt and content before copying into the explicit target.", "The restore command does not open the restored stores under current schema code or run replay canaries.", "Schema convergence, no-repeat canaries, readiness, and rollback evidence remain separate required qualification gates.", "Cutover must not proceed until those gates are implemented and pass."],
    interfaces: [command("npm run backup:customer", "Create a protected customer backup."), command("npm run restore:customer", "Restore an authenticated backup under operator authority."), command("npm run dr:drill", "Run the deterministic disaster recovery drill."), api("GET /recovery/summary", "Read bounded recovery state."), api("GET /ready", "Read dependency readiness.")],
    evidence: [evidence("Disaster recovery", "packages/ops/src/disaster-recovery.test.ts"), evidence("Readiness", "packages/ops/src/readiness.test.ts"), evidence("Customer restore", "scripts/customer-backup-workflow.test.ts")],
    guardrails: ["An expired or mismatched receipt fails closed.", "Restore targets are explicit and cannot escape the declared root.", "Historical authenticated checkpoints and external effects are never rematerialized.", "No old authority is stopped before replacement health and rollback evidence pass."],
    limitations: ["Current schema convergence and no-repeat external-effect canaries are not performed by the restore command.", "Measured cross region RTO and RPO need an approved recovery target.", "Single node profiles do not imply high availability."],
    related: ["deployment-operations", "audit-compliance", "limits-errors"],
  }),
  page({
    slug: "limits-errors",
    title: "Limits, errors, and retries",
    category: "Operations",
    summary: "Treat every bounded input, overload response, partial result, and unavailable dependency as explicit operational state.",
    status: "limited_availability",
    statusLabel: "Profile specific limits",
    availability: "Runtime bounds and error contracts vary by route, workload tier, and deployment profile",
    lastVerified: "2026-08-30",
    startHere: { intro: "Read the exact route contract and declare a workload budget before sending production work.", steps: ["Confirm input byte, file, path, token, time, cost, and concurrency bounds for the route.", "Supply request and idempotency identity where supported.", "Handle validation, authorization, conflict, overload, dependency, and internal failures separately.", "Abort at the declared threshold and preserve evidence for a bounded retry or rollback."] },
    capabilities: ["Bounded request and response bodies", "Concurrency admission and Retry After guidance", "Structured error codes and request identity", "Budget, timeout, and saturation controls", "Explicit partial, indeterminate, and unavailable states"],
    useWhen: ["A caller needs a safe retry policy.", "An operator needs to size or abort a production workload."],
    howItWorks: ["Each route validates its own inputs and authority before work.", "Admission control can reject excess concurrency with an explicit retry delay.", "Domain errors preserve a stable code; unexpected errors are redacted and retain request identity.", "Partial or indeterminate evidence remains distinct from success and from proven absence.", "Workload tests report declared percentiles and abort conditions for the tested profile only."],
    interfaces: [artifact("Error response", "HTTP status, stable code, and request identity where available."), configuration("Retry-After", "Explicit overload delay in seconds."), artifact("Performance contract", "Workload tier, concurrency, latency, cost, saturation, abort, and recovery boundaries."), configuration("Idempotency-Key", "Exact replay authority only on routes that declare it.")],
    evidence: [evidence("Production boundary", "apps/api/src/production.test.ts"), evidence("Error redaction", "apps/api/src/error-boundary.test.ts"), evidence("Performance contract", "docs/PERFORMANCE_CONTRACT.md")],
    guardrails: ["Never retry indefinitely.", "Never convert unavailable evidence into an empty successful result.", "Do not retry the same idempotency key with different request bytes.", "A synthetic or pilot workload is not production performance proof."],
    limitations: ["A universal API wide pagination and rate limit contract is not yet implemented.", "Production safe load and soak results require an approved target and workload envelope."],
    related: ["api-conventions", "deployment-operations", "recovery-reliability"],
  }),
  page({
    slug: "deployment-operations",
    title: "Deployment and operations",
    category: "Operations",
    summary: "Run Mendpoint with role-specific readiness, durable state, recovery controls, audit evidence, backups, and bounded rollout procedures.",
    status: "limited_availability",
    statusLabel: "Pilot evaluation",
    availability: "Docker Compose and Fly pilot deployment; the dedicated ReGauge profile is implemented but no live ReGauge deployment is claimed",
    startHere: { intro: "Choose the Fettler, ReGauge pilot, demo, or self-hosted profile and satisfy its complete startup contract before deployment.", steps: ["Validate the exact configuration and secret names without exposing values.", "Build and boot the production image against an existing-state database.", "Deploy one canary instance and verify liveness, readiness, storage, integrations, and rollback.", "Scale only after crash, response-loss, stale-fence, and restore drills pass."] },
    capabilities: ["Docker multi-stage images for API, web, worker, all-in-one Fly, and dedicated ReGauge roles", "Fly Fettler production and dedicated ReGauge coordinator/worker manifests", "Liveness, readiness, worker heartbeat, alerts, metrics, trajectories, and recovery summary", "Encrypted backup, restore, backup fencing, snapshots, disaster-recovery drill, and image rollback", "Lease-fenced jobs and checkpointed Fettler and ReGauge execution"],
    useWhen: ["An operator is preparing a new pilot environment.", "A release changes persistence, jobs, external effects, or readiness.", "A worker or process must be replaced without duplicating work."],
    howItWorks: ["Profile validation turns configuration into an explicit authority contract.", "Durable coordinators own leases and state; workers operate only under current fences.", "Health endpoints separate process liveness from dependency readiness.", "Deployments proceed through tests, production build, container smoke, canary, live checks, and recorded rollback.", "Backups and terminal evidence retain recovery and audit authority."],
    interfaces: [command("npm run ga:check", "Run specification, claim, action-pin, and GA checks."), command("npm run e2e:deployment", "Run the production deployment journey and crash recovery."), command("npm run dr:drill", "Exercise disaster recovery."), api("GET /live", "API process liveness."), api("GET /ready", "API dependency readiness."), api("GET /health", "Detailed runtime health."), configuration("fly.transformer.toml", "Separate coordinator and stateless worker production pilot.")],
    evidence: [evidence("Deployment E2E", "tests/e2e/deployment.spec.ts"), evidence("Readiness", "packages/ops/src/readiness.test.ts"), evidence("Backup and restore", "packages/ops/src/disaster-recovery.test.ts"), evidence("ReGauge profile contract", "apps/worker/src/transformer-production-profile.test.ts")],
    guardrails: ["A release is not complete until exact commit, image, health, and rollback evidence agree.", "Schema changes must boot against both fresh and pre-change databases.", "Coordinator and worker identities, storage, and fences must remain distinct across scale-out.", "Stopping workers preserves coordinator, volume, and immutable artifacts for evidence."],
    limitations: ["Optional model and source control integrations can create network egress", "High availability and enterprise support are not included", "The hosted Fettler profile is a single Fly application, not a multi-region high-availability control plane.", "No dedicated ReGauge deployment is claimed live until its app, secrets, volume, health, and canary evidence are independently verified."],
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
    schemaVersion: "2026-08-30.v3" as const,
    generatedFrom: "apps/web/app/docs/catalog.ts",
    pages: Object.freeze(PRODUCT_DOCS.map((page) => Object.freeze({
      slug: page.slug,
      title: page.title,
      category: page.category,
      status: page.status,
      statusLabel: page.statusLabel,
      availability: page.availability,
      lastVerified: page.lastVerified,
      publicationEvidence: page.publicationEvidence,
      webPath: `/docs/${page.slug}`,
      markdownPath: `./${page.slug}.md`,
      requirementIds: page.requirementIds,
      claimIds: page.claimIds,
      sourceContracts: page.sourceContracts,
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
    `Publication evidence: ${publicationEvidenceLabel(page.publicationEvidence)}`,
    `Requirements: ${page.requirementIds.join(", ")}`,
    `Public claims: ${page.claimIds.length > 0 ? page.claimIds.join(", ") : "None"}`,
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
    "", "## Contract sources", "", ...page.sourceContracts.map((locator) => `- \`${locator}\``),
    "", "## Safety model", "", ...page.guardrails.map((value) => `- ${value}`),
    "", "## Limitations", "", ...page.limitations.map((value) => `- ${value}`),
    "", "## See also", "", ...page.related.map((slug) => `- [${findProductDoc(slug)?.title ?? slug}](./${slug}.md)`),
    "",
  );
  return lines.join("\n");
}

function page(
  input: Omit<ProductDoc, "lastVerified" | "publicationEvidence" | "requirementIds" | "claimIds" | "sourceContracts">
    & Partial<Pick<ProductDoc, "lastVerified" | "publicationEvidence">>,
): ProductDoc {
  const authority = DOC_AUTHORITY[input.slug];
  if (!authority) throw new Error(`public_docs_authority_missing:${input.slug}`);
  return deepFreeze({
    ...input,
    ...authority,
    lastVerified: input.lastVerified ?? verified,
    publicationEvidence: input.publicationEvidence ?? notLivePublicationEvidence,
  }) as ProductDoc;
}

function api(name: string, detail: string) {
  assertPublicDocsApiRoute(name);
  return Object.freeze({ name, kind: "API" as const, detail });
}
function command(name: string, detail: string) { return Object.freeze({ name, kind: "Command" as const, detail }); }
function event(name: string, detail: string) { return Object.freeze({ name, kind: "Event" as const, detail }); }
function configuration(name: string, detail: string) { return Object.freeze({ name, kind: "Configuration" as const, detail }); }
function artifact(name: string, detail: string) { return Object.freeze({ name, kind: "Artifact" as const, detail }); }
function evidence(label: string, locator: string) { return Object.freeze({ label, locator }); }
function authority(requirementIds: readonly string[], claimIds: readonly string[], sourceContracts: readonly string[]): DocAuthority {
  return Object.freeze({ requirementIds: Object.freeze([...requirementIds]), claimIds: Object.freeze([...claimIds]), sourceContracts: Object.freeze([...sourceContracts]) });
}
function escapeTable(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }
function publicationEvidenceLabel(value: DocPublicationEvidence): string {
  return value.state === "live"
    ? `live; revision ${value.deployedRevision}; evidence digest ${value.evidenceDigest}`
    : "not live; no deployed revision or live evidence digest recorded";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
