# Mendpoint Product Specification

**Repository authority:** Superseded on 2026-08-17 by [`docs/product/mendpoint-product-platform-specification.md`](./product/mendpoint-product-platform-specification.md) (v2.0), which in turn was superseded on 2026-08-18 by [`docs/product/mendpoint-product-platform-specification-v3.md`](./product/mendpoint-product-platform-specification-v3.md) (v3.0), now the single canonical specification. Retained as history; see [`docs/adr/0001-canonical-product-specification.md`](./adr/0001-canonical-product-specification.md) and [`docs/adr/0004-canonical-product-specification-v3.md`](./adr/0004-canonical-product-specification-v3.md). The requirement register below now pins the v3.0 document.  
**Canonicalized:** 2026-08-01 (v1.0)  
**Source:** `C:\Users\Talal\Downloads\mendpoint_product_spec.md`  
**Requirement register:** [`PRODUCT_REQUIREMENTS.json`](./PRODUCT_REQUIREMENTS.json)  
**Release contract:** [`PRODUCT_CONTRACT.md`](./PRODUCT_CONTRACT.md)

This file preserves the supplied foundational product specification. Stable
requirement IDs, release tiers, current implementation status, owners, and
acceptance evidence are maintained separately so this narrative can remain
faithful to the source document.

## Document overview

**Product:** Mendpoint  
**Primary agents:** Fettler and Regauge  
**Document type:** Product specification / PRD + technical architecture brief  
**Status:** Working draft  
**Audience:** Founder, engineering, design partners, forward deployed engineers, GTM, future investors

## Product summary

Mendpoint is an AI-native migration platform that turns external change into reviewable code updates. It has two tightly connected products:

- **Fettler** monitors third-party API, SDK, and contract changes, maps them to affected customer code, and opens reviewable migration pull requests.
- **Regauge** handles broader legacy modernization and internal migration work, including framework upgrades, runtime migrations, SDK rewrites, codebase standardization, and architecture-level transformation campaigns.

The core thesis is simple: software teams should not discover breaking changes after they cause incidents, and API providers should not merely announce changes when software can help apply them. Fettler is the change-detection and remediation layer for external dependencies. Regauge is the migration engine for larger, harder, longer-horizon code evolution inside the customer environment.

Together, Fettler and Regauge make Mendpoint a full migration platform rather than a single-point API utility.

## Problem statement

Engineering teams lose time and reliability when changes happen outside their codebase and no trusted system translates those changes into safe updates. This failure shows up in several forms:

- Breaking API changes ship with incomplete adoption.
- New API capabilities launch but never get integrated.
- SDK and version deprecations create hidden operational risk.
- Changelogs, docs, and release notes do not map directly to impacted code.
- Legacy internal systems accumulate migration debt because upgrades are expensive, risky, and hard to scope.

Current tools only partially solve this:

- API management tools govern traffic and docs, but do not repair consumer code.
- Dependabot-style tools handle package versions, but not provider-specific semantic API changes.
- General coding agents can perform migrations, but they are horizontal, not opinionated around safety, graph impact analysis, explainability, or migration-specific workflows.

## Product vision

Mendpoint becomes the system of record for code change adoption.

In the long run:

- **Fettler** becomes the trusted interface between external platform changes and customer codebases.
- **Regauge** becomes the trusted interface between business intent and large-scale internal code migration.
- Every migration is graph-scoped, explainable, reviewable, testable, and measurable.
- Customers stop treating migration work as an ad hoc engineering burden and start treating it as an operating system capability.

## Product pillars

1. **Graph-scoped reasoning** — every recommendation begins with a map of what changed, what depends on it, and what code paths are affected.
2. **Review-first execution** — no silent production changes; output is a PR, patch set, migration plan, or staged campaign.
3. **Evidence-backed changes** — every proposed fix is linked to the source change, impacted code, and verification result.
4. **Hybrid model orchestration** — route work across open-source, post-trained, and frontier models based on task type, cost, and risk.
5. **Migration as a platform** — support both external dependency remediation (Fettler) and internal modernization (Regauge).

## Users

### Primary users

- Engineering managers responsible for reliability and upgrade velocity
- Staff and senior engineers maintaining integrations or platform code
- Developer productivity and platform engineering teams
- Security and compliance teams needing auditable code changes
- Solution architects and forward deployed engineers at API providers or large enterprises

### Secondary users

- API providers that want to help customers adopt changes faster
- Product and solution engineering teams running migration campaigns
- CTOs and VP Engineering teams tracking migration debt and technical risk

## Core use cases

### Fettler use cases

- Detect a breaking Stripe or payments API change and generate remediation PRs
- Track OpenAPI spec diffs and map changes to code references
- Identify dead or deprecated endpoint usage across repositories
- Generate migration guidance plus an executable PR
- Alert teams to low-adoption but high-value new API capabilities
- Run provider-wide migration campaigns for selected customer codebases

### Regauge use cases

- Upgrade a monolith from one framework version to another
- Migrate a service from one SDK or runtime to another
- Rewrite old integration patterns into current internal standards
- Convert legacy API consumption patterns into new architecture conventions
- Execute multi-stage code transformation programs across many repositories
- Build phased modernization plans before generating actual PRs

## Product positioning

Mendpoint is not just an AI coding tool. It is a migration operating layer.

- **Fettler** is the external-change remediation product.
- **Regauge** is the internal modernization product.

This matters because customers do not only need help when Stripe, Twilio, AWS, or another provider changes. They also need help when their own platform evolves, when internal standards shift, and when technical debt makes progress too slow. Fettler gets Mendpoint into the workflow through a sharp wedge. Regauge expands Mendpoint into a broader platform for code change adoption.

## Scope

### In scope for v1

- Repository connection to GitHub and GitLab
- OpenAPI / changelog / release note ingestion
- Spec diffing and structured change classification
- Codebase indexing and graph construction
- Impact analysis across repositories
- PR generation with explanation and confidence score
- Human review workflow with comments and evidence
- Verification pipeline integration (tests, linting, compile checks)
- Campaign dashboard for tracking changes and PR outcomes
- Regauge migration plan generation for selected modernization tasks
- Regauge staged PR campaigns for internal code migration

### Out of scope for v1

- Fully autonomous production deployment
- Automatic merge without review gates
- Arbitrary broad software engineering without migration context
- Full IDE replacement
- Full custom model training infrastructure from day one
- Broad non-code workflow automation

## Product architecture

### High-level architecture

Mendpoint consists of six layers:

1. **Change ingestion layer**
   - OpenAPI specs
   - SDK releases
   - Changelogs and release notes
   - Internal migration playbooks
   - Policy/rule ingestion

2. **Knowledge and graph layer**
   - Provider graph
   - Repository graph
   - Dependency graph
   - Call-site graph
   - Test and verification graph
   - Migration history graph

3. **Reasoning and routing layer**
   - Task classifier
   - Model router
   - Cost/risk policy engine
   - Retrieval and context assembly
   - Workflow orchestration

4. **Execution layer**
   - Fettler remediation engine
   - Regauge migration engine
   - Code edit generator
   - PR packager
   - Verification runner

5. **Human review layer**
   - Explanations
   - Diff review UI
   - Approval and rejection workflow
   - Inline evidence and test outcomes
   - Rollback and retry controls

6. **Observability and governance layer**
   - Trace logging
   - Cost accounting
   - Policy enforcement
   - Audit logs
   - Success metrics and evaluation dashboards

## Fettler specification

### Fettler purpose

Fettler detects external change and turns it into safe, reviewable remediation.

### Fettler workflow

1. Ingest provider change source.
2. Normalize and classify the change.
3. Build impacted-object graph.
4. Search connected repositories for affected usages.
5. Assemble contextual retrieval pack.
6. Route tasks to appropriate model(s).
7. Generate patch candidates.
8. Run compile/lint/test verification.
9. Package reviewable PR with explanation.
10. Track merge, rejection, follow-up edits, and post-merge outcomes.

### Fettler input types

- OpenAPI spec diff
- SDK changelog
- Release note
- Manual provider announcement
- Customer-reported incident
- Scheduled provider update campaign

### Fettler outputs

- Reviewable pull request
- Impact report
- Migration explanation
- Risk score
- Confidence score
- Test results
- Suggested rollout order
- Optional human-readable migration guide

### Fettler functional requirements

- Detect additive, breaking, behavioral, and deprecation changes
- Map API contract change to code references with repository and file precision
- Generate precise edits, not just recommendations
- Explain each change in natural language tied to source evidence
- Run tests and label failures as pre-existing vs introduced when possible
- Support org-wide scans and provider-scoped campaigns
- Maintain audit logs of every inference, edit, and reviewer action

## Regauge specification

### Regauge purpose

Regauge handles complex, internal, and legacy migration work that goes beyond one provider event. It turns migration intent into phased plans and reviewable code transformation campaigns.

### Regauge workflow

1. Ingest migration objective.
2. Parse codebase topology and standards.
3. Build migration graph and identify constraint boundaries.
4. Generate phased migration plan.
5. Prioritize repositories, modules, and dependency chains.
6. Produce staged code edits and PR batches.
7. Run verification after each stage.
8. Escalate ambiguous or high-risk transformation points to human review.
9. Track campaign completion, exceptions, and architectural drift.

### Regauge input types

- "Upgrade framework X from version A to B"
- "Migrate runtime from Python 3.10 to 3.13"
- "Replace internal SDK v1 with v2"
- "Standardize all authentication middleware"
- "Convert legacy service integrations to event-driven architecture"
- "Prepare codebase for vendor or infrastructure migration"

### Regauge outputs

- Migration blueprint
- Dependency and risk map
- Stage-by-stage execution plan
- PR campaign sequence
- Test and validation results
- Exceptions register
- Rollback guidance
- Executive modernization report

### Regauge functional requirements

- Support multi-repo and mono-repo migration planning
- Handle phased rollout and dependency ordering
- Support transformation recipes and reusable playbooks
- Separate plan generation from code generation when needed
- Preserve organization-specific coding and architecture conventions
- Generate incremental PRs instead of giant one-shot rewrites
- Provide high-confidence escape hatches when the graph is incomplete

## Shared system capabilities

### Graph engine

The graph engine is the central differentiator. It must support:

- Entity types: providers, endpoints, schemas, SDK methods, repos, files, functions, tests, services, owners
- Edges: calls, imports, dependencies, deprecations, ownership, runtime paths, verification coverage
- Temporal versioning of graph changes
- Query support for blast radius, migration paths, dependency ordering, and verification confidence

### Model orchestration

Mendpoint uses a router-based model stack:

- **Open-source/post-trained models** for bulk code pattern matching, provider-specific migrations, repetitive edit generation, and lower-risk transformations
- **Frontier models** for hard reasoning, ambiguous migrations, planning, and long-context synthesis
- **Rules engine** for deterministic transformation when possible
- **Fallback policy** to escalate difficult cases across models instead of failing silently

### Why this matters

This architecture improves cost and margin. Most work should run on tuned, cheaper models. Frontier models are reserved for expensive reasoning tasks. This makes Mendpoint a vertical AI application with improving economics as migration data compounds.

## Data strategy

### Proprietary data assets

- Historical migration diffs
- Accepted vs rejected PR outcomes
- Provider-specific change patterns
- Verification and failure traces
- Human review comments
- Architecture and coding convention fingerprints
- Migration recipe library

### Data flywheel

1. More migrations create better transformation data.
2. Better data improves provider- and framework-specific recipes.
3. Better recipes reduce compute cost and increase acceptance rate.
4. Higher acceptance increases trust and distribution.
5. More distribution creates more migration data.

Fettler generates valuable data around external changes. Regauge generates valuable data around internal modernization. Together they create a stronger model moat than either could alone.

## User experience

### Main surfaces

- Marketing site
- Admin dashboard
- Change event detail page
- Impact analysis page
- PR review and explanation page
- Migration campaign dashboard
- Regauge migration blueprint workspace
- Audit and analytics views

### Core UX principles

- Show affected code before suggested changes
- Make explanations visible near every edit
- Let users review diffs by semantic category, not just file order
- Make tests, risk, and confidence obvious
- Favor phased execution over one-click magic
- Keep Fettler event-driven and fast
- Keep Regauge plan-driven and structured

## Functional requirements

### Repository integration

- Connect GitHub/GitLab repos through app installation or token-based integration
- Support org, repo, branch, and environment scoping
- Pull code, tests, ownership metadata, and CI results

### Change ingestion

- Support direct spec upload and URL pull for OpenAPI
- Parse release notes and structured changelog feeds
- Detect semantic difference between versions

### PR generation

- Create branch, commit set, and PR title/body automatically
- Include rationale, linked evidence, risk rating, and verification summary
- Support draft PR mode and staged PR batches

### Review and governance

- Manual approval workflow
- Approval policies by repo or risk class
- Audit logs and replay traces
- Policy rules for forbidden edit zones

### Campaign management

- Launch a provider migration campaign across many repos
- Launch a Regauge modernization campaign across many repos
- Track status by repo, team, owner, and change class
- Support pause, rollback, and retry

## Non-functional requirements

### Reliability

- Idempotent change ingestion
- Deterministic replay for auditable runs where possible
- Graceful retry on repo, CI, or model failure

### Security

- Least-privilege repository access
- Encryption in transit and at rest
- Tenant isolation
- Secrets redaction and boundary controls
- Optional self-hosted or VPC deployment for enterprise

### Performance

- Small-repo Fettler impact analysis in minutes, not hours
- Large campaign summary available quickly, even while deeper scans continue
- Regauge plans should generate staged output without requiring whole-campaign completion first

### Explainability

- Every edit linked to evidence and rationale
- Confidence score at file, change, and PR levels
- Clear reason for model escalation and fallback

### Compliance

- Audit trails for regulated customers
- Change approvals and reviewer history
- Support for SOC 2 / enterprise security expectations in roadmap

## MVP definition

### MVP 1: Fettler wedge

Goal: prove that external API changes can reliably become reviewable PRs.

Includes:

- GitHub integration
- OpenAPI spec diff ingestion
- Repo scanning for impacted usages
- PR generation for selected API change classes
- Basic explanation and verification output
- Dashboard for event, impact, and PR status

### MVP 2: Regauge expansion

Goal: prove that the same graph and review architecture can support broader modernization.

Includes:

- Internal migration objective intake
- Migration graph generation
- Phase plan output
- Staged PR batches for one migration class
- Campaign dashboard with progress tracking

## Success metrics

### Fettler metrics

- Time from provider change to first PR
- PR acceptance rate
- Merge rate
- False-positive impact detections
- Regression rate after merge
- Engineering hours saved
- Incidents prevented or remediated faster

### Regauge metrics

- Migration campaign completion rate
- PR batch acceptance rate
- Time to modernization completion
- Manual engineering time replaced
- Reduction in legacy surface area
- Improvement in upgrade velocity over time

### Shared business metrics

- MCU consumption per customer
- Gross margin per migration class
- Expansion from Fettler into Regauge usage
- Number of repos connected per account
- Logo retention and net revenue retention

## Pricing model

Mendpoint should use a consumption-driven model inspired by infrastructure and Cognition-style agent pricing.

### Pricing objects

- **Migration Compute Unit (MCU):** a normalized unit for graph scan + retrieval + edit generation + verification effort
- **Campaign fee:** optional overlay for large coordinated migrations
- **Firm-fixed-price engagement:** for regulated or scoped enterprise migration outcomes

### Why this model works

- Aligns pricing with delivered migration work, not seats alone
- Scales with customer value
- Works for both Fettler and Regauge
- Supports a low-friction wedge and enterprise expansion

## Go-to-market implications

### Fettler as entry wedge

Fettler is easier to explain, easier to pilot, and more time-sensitive. It should be the initial product wedge.

### Regauge as expansion motion

Once trust is established, customers will ask for adjacent migration work: SDK upgrades, runtime upgrades, framework migrations, and architectural modernization. Regauge monetizes that pull.

This makes the product strategy:

1. Land with Fettler on an urgent external change problem.
2. Expand with Regauge into broader migration programs.
3. Become the default migration platform for the account.

## Risks and mitigations

| Risk | Description | Mitigation |
|---|---|---|
| Incomplete graph | Impact analysis misses hidden usages | Hybrid static analysis, runtime metadata, human review fallback |
| Low trust | Teams hesitate to merge AI-generated PRs | Review-first design, evidence UI, draft PR mode |
| Model cost | Frontier-heavy reasoning hurts margins | Router strategy, post-training, deterministic recipes |
| Broad scope | Product becomes generic coding agent | Keep Fettler and Regauge centered on migration workflows |
| Verification gaps | Passing tests may not equal safe behavior | Add policy tests, smoke tests, and staged rollout support |
| Slow enterprise adoption | Security and access concerns delay pilots | Self-host/VPC roadmap, least-privilege access, FDE support |

## Roadmap

### Phase 1

- Fettler MVP
- GitHub integration
- OpenAPI diffing
- First migration PR workflow
- Basic dashboard and audit trail

### Phase 2

- Multi-provider support
- GitLab support
- Better verification and confidence scoring
- Campaign orchestration
- First design partners

### Phase 3

- Regauge migration planning
- Staged modernization campaigns
- Reusable migration recipes
- Enterprise deployment controls

### Phase 4

- Post-trained provider/framework models
- Cross-account benchmarking
- Provider-side campaign products
- Advanced policy engine and approvals

## Acceptance criteria

### Fettler acceptance criteria

- A provider change can be ingested and classified correctly
- Impacted code can be identified with usable precision
- A draft PR can be created with explanations and verification output
- A reviewer can approve, reject, or request regeneration
- Audit logs persist the full decision path

### Regauge acceptance criteria

- A migration objective can be translated into a staged plan
- The system can generate at least one validated PR batch from that plan
- The user can track progress and exceptions across the campaign
- The system can preserve organization-specific constraints and boundaries

## Narrative for customers and investors

Mendpoint is building the migration layer for software.

- **Fettler** solves external change adoption.
- **Regauge** solves internal modernization.

The market entry is narrow and urgent: when providers change, code breaks. The platform expansion is broad and compounding: every organization also has ongoing migration debt. Fettler earns trust by fixing what just changed. Regauge expands that trust into the rest of the codebase.

That combination is the long-term product story and should remain explicit in product, GTM, fundraising, and hiring materials going forward.

## Vertical AI router architecture

### Strategic framing

Mendpoint is a vertical AI company, not a single-model wrapper. The vertical is migration and code change adoption. Fettler owns the external-change slice of that vertical. Regauge owns the internal-modernization slice. Both products sit behind the same router and post-training infrastructure so the company benefits from one compounding model strategy instead of two disconnected ones.

The broader industry pattern behind this decision: routers, open-source models, and specialized post-training (enabled by infrastructure providers such as Fireworks AI) have advanced enough that vertical AI companies can post-train an open-source model on their own proprietary data, place it behind a router alongside frontier models, and match or beat frontier-only performance at a fraction of the cost. Legora has demonstrated this in legal AI. Cognition is moving in the same direction for coding agents. Mendpoint should build the same architecture natively into both Fettler and Regauge rather than treating it as a future optimization.

### Vertical focus definition

Mendpoint's vertical is narrow and explicit: turning code change, external or internal, into reviewable migration pull requests. This vertical splits into two workflows that share infrastructure but serve different triggers:

- **Fettler's workflow:** provider-driven change → impact graph → migration PR
- **Regauge's workflow:** modernization intent → migration plan → staged migration PR campaign

Both workflows are migration-specific, not general-purpose coding. This is the discipline that keeps Mendpoint a vertical AI company instead of drifting into a horizontal coding agent, which is already contested by Devin, Claude Code, Cursor, and Copilot.

### Router layer

A model router sits in front of every model and tool call in the system, for both Fettler and Regauge. The router receives a structured task spec, not a raw prompt, and decides which execution path should handle it.

**Router responsibilities:**

- Classify each subtask by type: bulk pattern-matching, vendor-specific idiom translation, complex refactor, long-horizon planning, or safety-critical reasoning
- Select the lowest-cost model or adapter capable of meeting the required confidence threshold for that subtask
- Escalate automatically to a frontier model when confidence, complexity, or risk exceeds the threshold for the cheaper option
- Track cost, latency, and acceptance outcome per model per task type to continuously tune routing policy
- Apply the same routing logic across Fettler and Regauge, since both products generate the same underlying primitive: a reviewable code edit

**Router inputs per task:**

- Task type (scan, impact analysis, edit generation, verification, plan generation, campaign sequencing)
- Provider or framework context (e.g., Stripe, Twilio, Django, internal SDK v1 to v2)
- Historical acceptance rate for this task type and context on each candidate model
- Risk classification (low, medium, high) based on blast radius from the graph
- Cost ceiling and latency requirement from the customer's plan tier

**Router outputs:**

- Selected model or adapter
- Fallback chain if the primary selection fails verification
- Logged rationale for selection, feeding back into the routing policy over time

This is architecturally similar to router implementations like Otari or the TMP Router pattern: one integration point, multiple backend providers, per-key and per-task budget and policy enforcement, with routing decisions made dynamically rather than hardcoded per feature.

### Post-trained open-source model layer

Mendpoint post-trains open-source code models on its own proprietary migration data, the same strategy Legora uses with legal data and that Cognition is exploring for coding.

**Data used for post-training:**

- Historical Fettler migration diffs, labeled by provider and change type
- Historical Regauge migration diffs, labeled by framework, runtime, and pattern
- Accepted vs. rejected PR outcomes, including reviewer edits and rationale
- Verification results (test pass/fail, lint outcomes, regression signals)
- Vendor-specific idiom patterns collected across customers, anonymized and generalized

**Candidate base models:** open, commercially licensed code models such as Codestral or StarCoder, selected for cost and fine-tuning flexibility rather than raw benchmark supremacy.

**Post-training scope:**

- **Vendor adapters:** a per-provider fine-tuned adapter (e.g., a Stripe adapter, a Twilio adapter) trained specifically on that provider's historical change patterns and typical remediation code
- **Framework adapters:** a per-framework fine-tuned adapter for Regauge's most common modernization targets (e.g., a Django upgrade adapter, a Python 3.x runtime adapter)
- **General migration adapter:** a broader adapter trained across all migration data for tasks that do not cleanly map to one vendor or framework

**Why this compounds:** every migration Mendpoint completes, across every customer, adds labeled training data that improves the relevant adapter, which lowers cost and improves acceptance rate on the next similar migration, which increases the volume of migrations processed, which produces more data. This is the same data flywheel dynamic already described for the graph engine, now extended explicitly to the model layer.

### Frontier model backup layer

Frontier models (Claude, GPT, Gemini, Grok) remain available behind the router but are reserved for the cases that justify their cost:

- Ambiguous migrations where the graph is incomplete or the change type is novel
- Long-horizon planning tasks in Regauge, such as multi-phase modernization campaigns spanning many repositories
- Safety-critical reasoning where an incorrect edit carries high blast radius
- Complex refactors that require synthesizing context across many files or services simultaneously
- Any task where the post-trained adapter's confidence score falls below the router's threshold

Frontier models are not the default execution path for every token processed. They are the fallback for the subset of work that genuinely requires frontier-level reasoning, which keeps Mendpoint's average cost per migration low while preserving quality on hard cases.

### Fettler as orchestrator, not just an agent

Fettler's role changes from "the agent that generates PRs" to "the orchestrator that calls the router with a task spec and assembles the result." This distinction matters for both products:

1. Fettler receives an event (e.g., "Stripe deprecates endpoint X") and converts it into a structured task spec.
2. Fettler queries the graph for blast radius and affected code.
3. Fettler sends each subtask to the router.
4. The router selects the vendor adapter, general adapter, or frontier model per subtask.
5. Fettler collects candidate edits, runs verification, and packages the result into a PR with explanation and evidence.

Regauge follows the same orchestration pattern for its own workflow: it converts a modernization objective into a staged task spec, sends each stage's subtasks to the router, collects and verifies edits per stage, and packages staged PR batches. Both agents are orchestrators over the same router and adapter infrastructure; they differ only in trigger type (external event vs. internal objective) and output cadence (single PR vs. staged campaign).

### Concrete routing examples

| Task | Product | Routing decision |
|---|---|---|
| Bulk scan for deprecated endpoint usage across 200 repos | Fettler | Cheap open-source model, general migration adapter |
| Generate Stripe-specific remediation edit | Fettler | Post-trained Stripe vendor adapter |
| Plan a 6-month framework migration across a monorepo | Regauge | Frontier model for long-horizon planning |
| Rewrite legacy auth middleware to new internal standard | Regauge | Post-trained framework adapter, escalate to frontier on low confidence |
| Resolve an ambiguous, undocumented breaking change with no clear pattern | Fettler | Frontier model, high-risk classification |
| Sequence PR batch order across dependent services | Regauge | Frontier model, cross-service reasoning |

### Business model impact

This architecture changes Mendpoint's unit economics and pricing narrative in three concrete ways, extending the MCU-based pricing model already defined for Fettler and Regauge.

**Lower COGS per migration:** because most Migration Compute Units are served by the post-trained open-source adapters rather than frontier models, marginal cost per MCU drops materially compared to a frontier-only architecture. This improves gross margin at the same usage-based price point, or allows more competitive per-MCU pricing without sacrificing margin.

**Better cost/ROI pricing story:** Mendpoint's outcome-based pricing (per merged PR, per avoided incident) can now be paired with a concrete cost-efficiency claim: most work is handled by a model tuned on Mendpoint's own migration data, with frontier models reserved for genuinely hard cases. This directly counters the objection that frontier-only agents are too expensive to run at scale across every repository and every provider change.

**Model-neutral "Switzerland" positioning:** because the router treats every model, open-source or frontier, as interchangeable infrastructure selected per task, Mendpoint is not dependent on any single model lab remaining best-in-class. This mirrors Cognition's explicit strategy of not building or betting on a single proprietary frontier model, which enterprise buyers value because they do not want to retrain their workflows around a single vendor's roadmap.

### Updated pricing narrative

The MCU pricing model gains a supporting technical claim: Mendpoint delivers migration outcomes at lower marginal cost than frontier-only competitors because most Migration Compute Units run on a proprietary, post-trained adapter rather than a frontier model billed at frontier rates. This should be stated explicitly in customer-facing pricing materials and investor materials as the underlying reason Mendpoint's per-MCU price can remain competitive while gross margin improves over time as the data flywheel matures.

### Vertical sequencing decision

Two sequencing options exist for how narrowly to focus the vertical at launch:

- **Single-vertical-first:** focus initial post-training and go-to-market entirely on one API category, such as payments and fintech APIs, leveraging the founder's LSEG and PayPal background for both domain credibility and design partner access. This produces a sharper vertical AI story, faster adapter maturity for that specific domain, and a clearer initial ICP for sales.
- **Cross-API-from-day-one:** support multiple provider categories simultaneously from launch, trading a less sharp initial vertical story for broader addressable market and faster discovery of which vertical actually pulls hardest.

Given the founder's direct domain expertise in payments and financial infrastructure integration, the single-vertical-first path (payments and fintech APIs) is the stronger default: it lets the Stripe vendor adapter and payments-specific graph patterns mature fastest, gives the go-to-market motion a concrete initial ICP consistent with the land-and-expand strategy already defined for Fettler, and preserves the option to add provider categories and corresponding adapters once the payments vertical adapter demonstrates strong acceptance rates and cost advantage.
