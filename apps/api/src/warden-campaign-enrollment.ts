import { createHash, randomUUID } from "node:crypto";
import {
  autoEnrollWardenCampaignOrg,
  getProviderBySlug,
  getScmConnection,
  recordAudit,
  type AppDb,
  type WardenOrgRepositoryCandidate,
} from "@mendpoint/db";
import {
  listInstallationRepositories,
  type InstallationRepository,
  type MockInstallationRepositoryInput,
} from "@mendpoint/github";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";

const MAX_BODY_BYTES = 64 * 1_024;
const MAX_MOCK_REPOSITORIES = 500;
const ALLOWED_FIELDS = new Set(["providerSlug", "connectionId", "mockRepositories"]);
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const ERRORS: readonly PublicErrorRule[] = [
  { internalCode: "warden_enroll_authentication_required", publicCode: "unauthorized", status: 401 },
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
  routes.post("/:id/enroll-org", async (c) => {
    try {
      const principal = c.get("principal");
      const tenantId = c.get("tenantId");
      const trustPrincipalId = c.get("trustPrincipalId");
      if (!principal || !tenantId || principal.tenantId !== tenantId || !trustPrincipalId) {
        throw new Error("warden_enroll_authentication_required");
      }
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
