import { createHash, randomUUID } from "node:crypto";
import {
  autoEnrollWardenCampaignOrg,
  createMission,
  createWardenCampaign,
  getPrincipal,
  getProviderBySlug,
  getScmConnection,
  getTenantMembership,
  getWardenCampaign,
  linkFettlerCampaignToMission,
  recordAudit,
  type AppDb,
  type WardenOrgRepositoryCandidate,
} from "@mendpoint/db";
import {
  listInstallationRepositories,
  type InstallationRepository,
  type MockInstallationRepositoryInput,
} from "@mendpoint/github";
import { ensureDefaultPolicyEnvelopeBinding } from "@mendpoint/pipeline";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";
import { isHumanWardenReviewer } from "./warden-review-auth.js";

const MAX_BODY_BYTES = 64 * 1_024;
const MAX_MOCK_REPOSITORIES = 500;
const ALLOWED_FIELDS = new Set(["providerSlug", "connectionId", "mockRepositories"]);
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const ERRORS: readonly PublicErrorRule[] = [
  // authorizeCampaignWriter / reverifyCampaignWriter (shared with the create
  // path) throw these; enrolment maps them identically so both routes on this
  // resource refuse with the same 401/403 taxonomy.
  { internalCode: "warden_campaign_create_authentication_required", publicCode: "unauthorized", status: 401 },
  { internalCode: "warden_campaign_create_forbidden", publicCode: "forbidden", status: 403 },
  { internalCode: "warden_campaign_not_found", publicCode: "not_found", status: 404 },
  { internalCode: "warden_enroll_connection_not_found", publicCode: "not_found", status: 404 },
  { internalCode: "warden_org_provider_unknown", publicCode: "not_found", status: 404 },
  { internalCode: "warden_campaign_not_draft", publicCode: "campaign_not_draft", status: 409 },
  { internalCode: "warden_org_installation_not_connected", publicCode: "installation_not_connected", status: 409 },
  { internalCode: "warden_enroll_connection_revoked", publicCode: "connection_revoked", status: 409 },
  { internalCode: "warden_principal_tenant_mismatch", publicCode: "forbidden", status: 403 },
  ...[
    "warden_enroll_content_type_invalid",
    "warden_enroll_payload_invalid",
    "warden_enroll_field_forbidden",
    "warden_enroll_campaign_invalid",
    "warden_enroll_provider_invalid",
    "warden_enroll_connection_invalid",
    "warden_enroll_connection_not_github",
    "warden_enroll_mock_repositories_invalid",
    "warden_org_installation_id_invalid",
  ].map((internalCode): PublicErrorRule => ({ internalCode, status: 422 })),
];

const CREATE_MAX_BODY_BYTES = 8 * 1_024;
const CREATE_ALLOWED_FIELDS = new Set(["name", "concurrencyLimit", "completionPolicy"]);
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const COMPLETION_POLICIES = new Set(["all", "continue_on_failure"]);

const CREATE_ERRORS: readonly PublicErrorRule[] = [
  { internalCode: "warden_campaign_create_authentication_required", publicCode: "unauthorized", status: 401 },
  { internalCode: "warden_campaign_create_forbidden", publicCode: "forbidden", status: 403 },
  { internalCode: "warden_principal_tenant_mismatch", publicCode: "forbidden", status: 403 },
  // A replay carrying the same Idempotency-Key but a different body resolves to
  // the same tenant-derived id and mismatches the stored campaign: a client
  // conflict, never a masked 500.
  { internalCode: "warden_campaign_id_conflict", publicCode: "idempotency_conflict", status: 409 },
  ...[
    "warden_campaign_create_content_type_invalid",
    "warden_campaign_create_payload_invalid",
    "warden_campaign_create_field_forbidden",
    "warden_campaign_create_idempotency_key_invalid",
    "warden_campaign_create_name_invalid",
    "warden_campaign_create_concurrency_invalid",
    "warden_campaign_create_completion_policy_invalid",
    // Defensive: surface the db layer's own validation as 422 rather than 500.
    "warden_campaign_name_invalid",
    "warden_campaign_id_invalid",
    "tenant_id_invalid",
    "warden_concurrency_invalid",
  ].map((internalCode): PublicErrorRule => ({ internalCode, status: 422 })),
];

function membershipEvidenceId(tenantId: string, issuer: string, subject: string): string {
  return `membership:${createHash("sha256")
    .update(`${tenantId}\n${issuer}\n${subject}`, "utf8")
    .digest("hex")}`;
}

/**
 * Human campaign-writer authorization, matching the repository's strongest gate
 * (apps/api/src/warden-candidate-review.ts): OIDC-only, a non-revoked human
 * trust principal, and an active tenant membership whose evidence id matches the
 * one the auth middleware bound to the request. Returns the derived issuer /
 * subject / evidence id so the caller can re-verify immediately before the write.
 */
function authorizeCampaignWriter(c: Context<ApiEnv>, db: AppDb) {
  const principal = c.get("principal");
  const tenantId = c.get("tenantId");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!principal || !tenantId || principal.tenantId !== tenantId || !trustPrincipalId) {
    throw new Error("warden_campaign_create_authentication_required");
  }
  const trust = getPrincipal(db, tenantId, trustPrincipalId);
  if (!isHumanWardenReviewer(principal, trust, tenantId, c.get("apiKeyId"))) {
    throw new Error("warden_campaign_create_forbidden");
  }
  const issuer = trust?.audience ?? "";
  const subjectPrefix = issuer ? `${issuer}|` : "";
  const subject = trust?.subject.startsWith(subjectPrefix) ? trust.subject.slice(subjectPrefix.length) : "";
  const evidenceId = issuer && subject ? membershipEvidenceId(tenantId, issuer, subject) : "";
  const membership = issuer && subject ? getTenantMembership(db, tenantId, issuer, subject) : undefined;
  if (c.get("authMethod") !== "oidc" || !membership || membership.status !== "active" ||
      c.get("membershipEvidenceId") !== evidenceId) {
    throw new Error("warden_campaign_create_forbidden");
  }
  return { principal, tenantId, trustPrincipalId, issuer, subject, evidenceId };
}

/**
 * Re-run the membership/trust checks against live rows, defending against a
 * revocation that lands between the entry gate and the write. Called
 * synchronously immediately before createWardenCampaign, with no intervening
 * await: node:sqlite is synchronous and the runtime single-threaded, so no
 * concurrent in-process write can interleave, and createWardenCampaign's own
 * assertPrincipal re-checks the trust principal is non-revoked at write time.
 */
function reverifyCampaignWriter(
  c: Context<ApiEnv>,
  db: AppDb,
  ctx: { tenantId: string; trustPrincipalId: string; issuer: string; subject: string; evidenceId: string },
  at: string,
): void {
  const trust = getPrincipal(db, ctx.tenantId, ctx.trustPrincipalId);
  const atMs = Date.parse(at);
  const trustActive = Boolean(trust && trust.kind === "human" && trust.tenant_id === ctx.tenantId &&
    trust.audience === ctx.issuer && trust.subject === `${ctx.issuer}|${ctx.subject}` &&
    trust.revoked_at === null && (!trust.expires_at || Date.parse(trust.expires_at) > atMs));
  const membership = ctx.issuer && ctx.subject ? getTenantMembership(db, ctx.tenantId, ctx.issuer, ctx.subject) : undefined;
  if (!Number.isFinite(atMs) || !trustActive || !membership || membership.status !== "active" ||
      c.get("authMethod") !== "oidc" || c.get("membershipEvidenceId") !== ctx.evidenceId) {
    throw new Error("warden_campaign_create_forbidden");
  }
}

function requiredCreateText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

async function createBody(c: Context<ApiEnv>) {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("warden_campaign_create_content_type_invalid");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > CREATE_MAX_BODY_BYTES) {
    throw new Error("warden_campaign_create_payload_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("warden_campaign_create_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("warden_campaign_create_payload_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !CREATE_ALLOWED_FIELDS.has(key))) {
    throw new Error("warden_campaign_create_field_forbidden");
  }
  const name = requiredCreateText(value.name, "warden_campaign_create_name_invalid", 200);
  const concurrencyLimit = value.concurrencyLimit === undefined ? 1 : Number(value.concurrencyLimit);
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 100) {
    throw new Error("warden_campaign_create_concurrency_invalid");
  }
  const completionPolicy = value.completionPolicy === undefined ? "all" : value.completionPolicy;
  if (typeof completionPolicy !== "string" || !COMPLETION_POLICIES.has(completionPolicy)) {
    throw new Error("warden_campaign_create_completion_policy_invalid");
  }
  return { name, concurrencyLimit, completionPolicy: completionPolicy as "all" | "continue_on_failure" };
}

export type WardenCampaignEnrollmentOptions = Readonly<{
  db: AppDb;
  now?: () => string;
  crawl?: (input: Readonly<{
    installationId: number;
    accountLogin: string;
    mockRepositories?: readonly MockInstallationRepositoryInput[];
  }>) => Promise<InstallationRepository[]>;
}>;

function requiredText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function parseMockRepositories(value: unknown): MockInstallationRepositoryInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MOCK_REPOSITORIES) {
    throw new Error("warden_enroll_mock_repositories_invalid");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("warden_enroll_mock_repositories_invalid");
    }
    const record = entry as Record<string, unknown>;
    const name = requiredText(record.name, "warden_enroll_mock_repositories_invalid", 200);
    const owner = record.owner === undefined
      ? undefined
      : requiredText(record.owner, "warden_enroll_mock_repositories_invalid", 200);
    const id = record.id === undefined ? undefined : Number(record.id);
    if (id !== undefined && (!Number.isSafeInteger(id) || id < 1)) {
      throw new Error("warden_enroll_mock_repositories_invalid");
    }
    return Object.freeze({
      name,
      ...(owner ? { owner } : {}),
      ...(id !== undefined ? { id } : {}),
      archived: record.archived === true,
      disabled: record.disabled === true,
    });
  });
}

async function body(c: Context<ApiEnv>) {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("warden_enroll_content_type_invalid");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new Error("warden_enroll_payload_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("warden_enroll_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("warden_enroll_payload_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new Error("warden_enroll_field_forbidden");
  }
  return {
    providerSlug: requiredText(value.providerSlug, "warden_enroll_provider_invalid", 100),
    connectionId: requiredText(value.connectionId, "warden_enroll_connection_invalid", 200),
    mockRepositories: parseMockRepositories(value.mockRepositories),
  };
}

export function createWardenCampaignEnrollmentRoutes(options: WardenCampaignEnrollmentOptions) {
  const routes = new Hono<ApiEnv>();
  const now = options.now ?? (() => new Date().toISOString());
  const crawl = options.crawl ?? ((input) => listInstallationRepositories(input));

  // The sole production caller of createWardenCampaign. Without it the campaign
  // layer (state machine, dependency DAG, rollout/rollback planners) and the
  // enroll-org route below have no reachable campaign to act on.
  routes.post("/", async (c) => {
    try {
      const auth = authorizeCampaignWriter(c, options.db);
      const input = await createBody(c);
      const idempotencyKey = c.req.header("Idempotency-Key")?.trim() ?? "";
      if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new Error("warden_campaign_create_idempotency_key_invalid");
      }
      // Structural tenant binding: tenantId is folded into the content digest and
      // therefore into the primary key. Two tenants replaying the same key derive
      // different ids, so a campaign id cannot collide across tenants or be forged
      // into another tenant's namespace.
      const identity = createHash("sha256")
        .update(`${auth.tenantId}\0${idempotencyKey}`, "utf8")
        .digest("hex");
      const campaignId = `fettler-campaign-${identity.slice(0, 32)}`;
      const at = now();

      // A replay must not error or duplicate. createWardenCampaign is itself
      // idempotent on an exact field match and only compares immutable fields
      // (tenant, name, owner, concurrency, policy) — none of which a later
      // transition mutates — so a replay after the campaign has started running
      // still returns the stored campaign rather than raising a conflict. The
      // pre-read only distinguishes 201 (created) from 200 (replayed).
      const existing = getWardenCampaign(options.db, auth.tenantId, campaignId);
      reverifyCampaignWriter(c, options.db, auth, at);
      const campaign = createWardenCampaign(options.db, {
        id: campaignId,
        tenantId: auth.tenantId,
        name: input.name,
        ownerPrincipalId: auth.trustPrincipalId,
        concurrencyLimit: input.concurrencyLimit,
        completionPolicy: input.completionPolicy,
        eventId: `${campaignId}-created`,
        idempotencyKey: `warden-campaign-create-${campaignId}`,
        correlationId: campaignId,
        createdAt: at,
      });

      if (!existing) {
        recordAudit(options.db, {
          id: `audit_${createHash("sha256")
            .update(`${auth.tenantId}\0${campaignId}\0created`)
            .digest("hex")}`,
          tenantId: auth.tenantId,
          actor: auth.principal.id,
          principalId: auth.trustPrincipalId,
          requestId: c.get("requestId") ?? null,
          action: "warden.campaign.created",
          resourceType: "warden_campaign",
          resourceId: campaignId,
          metadata: {
            name: campaign.name,
            concurrencyLimit: campaign.concurrencyLimit,
            completionPolicy: campaign.completionPolicy,
          },
        });
      }

      return c.json({
        campaignId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        concurrencyLimit: campaign.concurrencyLimit,
        completionPolicy: campaign.completionPolicy,
        revision: campaign.revision,
        createdAt: campaign.createdAt,
        replayed: Boolean(existing),
      }, existing ? 200 : 201);
    } catch (error) {
      return mappedErrorResponse(c, error, CREATE_ERRORS);
    }
  });

  routes.post("/:id/enroll-org", async (c) => {
    try {
      // Enrolment binds an organization's repositories into a campaign and is at
      // least as sensitive as creating one, so it holds the same bar: the
      // strongest gate in the repository (apps/api/src/warden-candidate-review.ts),
      // reused verbatim from the create path above rather than reimplemented.
      const auth = authorizeCampaignWriter(c, options.db);
      const { principal, tenantId, trustPrincipalId } = auth;
      const campaignId = (c.req.param("id") ?? "").trim();
      if (!CAMPAIGN_ID.test(campaignId)) throw new Error("warden_enroll_campaign_invalid");
      const input = await body(c);

      const connection = getScmConnection(options.db, input.connectionId, tenantId);
      if (!connection) throw new Error("warden_enroll_connection_not_found");
      if (connection.provider !== "github") throw new Error("warden_enroll_connection_not_github");
      if (connection.revoked_at) throw new Error("warden_enroll_connection_revoked");
      const installationId = connection.external_account_id;
      // Validate the campaign and provider exist for this tenant before crawling.
      if (!getProviderBySlug(options.db, input.providerSlug)) {
        throw new Error("warden_org_provider_unknown");
      }

      const repositories = await crawl({
        installationId: Number(installationId),
        accountLogin: connection.display_name,
        mockRepositories: input.mockRepositories,
      });
      const accessibleRepositories: WardenOrgRepositoryCandidate[] = repositories.map((repo) =>
        Object.freeze({
          remoteId: String(repo.id),
          owner: repo.owner,
          name: repo.name,
          archived: repo.archived,
          disabled: repo.disabled,
        }),
      );

      const at = now();
      // Re-verify against live rows immediately before the write. Unlike create,
      // an await (the installation crawl) sits between the entry gate and here, so
      // this re-check is the defense against a trust revocation or membership
      // offboarding that lands mid-crawl, and its independent expiry check refuses
      // a principal that has expired since entry. No await follows before the
      // write, so no in-process state can change between this check and it.
      reverifyCampaignWriter(c, options.db, auth, at);
      const result = autoEnrollWardenCampaignOrg(options.db, {
        tenantId,
        campaignId,
        providerSlug: input.providerSlug,
        installationId,
        ownerPrincipalId: trustPrincipalId,
        accessibleRepositories,
        correlationId: campaignId,
        createdAt: at,
      });

      recordAudit(options.db, {
        id: `audit_${createHash("sha256")
          .update(`${tenantId}\0${campaignId}\0org-enroll\0${at}\0${randomUUID()}`)
          .digest("hex")}`,
        tenantId,
        actor: principal.id,
        principalId: trustPrincipalId,
        requestId: c.get("requestId") ?? null,
        action: "warden.campaign.org_enrolled",
        resourceType: "warden_campaign",
        resourceId: campaignId,
        metadata: {
          providerSlug: result.providerSlug,
          installationId: result.installationId,
          connectionId: connection.id,
          scanned: result.scanned,
          enrolled: result.enrolled.length,
          skipped: result.skipped.length,
        },
      });

      // Retire the inert Mission primitive (spec 6.1 / 8.6). A Fettler campaign is
      // the campaign-level Mission unit; its per-target attempts are the
      // MigrationTasks under it (v3 6.1: a Mission has "one or more migration
      // tasks"). Created and campaign-linked here at the API boundary because this
      // is where a real principal (trustPrincipalId) exists. The worker attempt
      // paths deliberately have no principal, which is exactly why the primitive
      // sat inert — nothing forgot to call it; the callers could not satisfy
      // assertPrincipal. Best-effort: Mission bookkeeping is metadata and must
      // never fail an enrollment (convention in packages/pipeline/src/index.ts);
      // never a bare catch. createMission/linkFettlerCampaignToMission are
      // idempotent, so repeated enrollments are safe.
      try {
        const missionId = `mission-fettler-${createHash("sha256")
          .update(`${tenantId}\0${campaignId}`)
          .digest("hex")
          .slice(0, 32)}`;
        createMission(options.db, {
          id: missionId,
          tenantId,
          product: "fettler",
          triggerKind: "provider_change",
          objective: `Fettler campaign ${campaignId}`.slice(0, 200),
          ownerPrincipalId: trustPrincipalId,
          eventId: `${missionId}-created`,
          idempotencyKey: `mission-create-${missionId}`,
          correlationId: campaignId,
          createdAt: at,
        });
        linkFettlerCampaignToMission(options.db, {
          tenantId,
          campaignId,
          missionId,
          actorPrincipalId: trustPrincipalId,
          eventId: `${missionId}-linked`,
          idempotencyKey: `mission-link-${missionId}`,
          correlationId: campaignId,
          createdAt: at,
        });
        // Spec §6.7: every Mission MUST reference a versioned Policy Envelope.
        // Bind the tenant's default envelope set-once at creation so downstream
        // task dispatch has an inherited, enforceable boundary rather than null.
        ensureDefaultPolicyEnvelopeBinding(options.db, {
          tenantId,
          missionId,
          actorPrincipalId: trustPrincipalId,
          correlationId: campaignId,
          createdAt: at,
        });
      } catch (error) {
        console.error(
          `fettler mission wiring failed tenant=${tenantId} campaign=${campaignId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return c.json({
        campaignId: result.campaignId,
        providerSlug: result.providerSlug,
        installationId: result.installationId,
        scanned: result.scanned,
        enrolled: result.enrolled.map((target) => ({
          targetId: target.id,
          repositoryId: target.repositoryId,
          snapshotId: target.snapshotId,
          enrollmentSource: target.enrollmentSource,
          enrolledInstallationId: target.enrolledInstallationId,
        })),
        skipped: result.skipped.map((skip) => ({
          remoteId: skip.remoteId,
          owner: skip.owner,
          name: skip.name,
          reason: skip.reason,
        })),
      }, 200);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });
  return routes;
}
