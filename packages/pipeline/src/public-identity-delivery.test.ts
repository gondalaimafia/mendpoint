/**
 * Public-identity projection at the customer-rendering boundary (#704 / #713 / #716).
 *
 * A tenant-private provider's stored slug is `<tenantId>~<requested>` and the Change Graph keys
 * its nodes by the tenant id. Neither the tenant id (an unsalted hash of issuer+email) nor the
 * `~` namespace separator may reach a customer repository. These tests run the REAL change
 * pipeline end to end through the adoptive delivery transport and scan every customer-visible
 * string a delivery produces (PR title, body, branch, commit message, file contents):
 *
 *  1. For a private provider stored namespaced, none of those strings contain the tenant id or `~`.
 *  2. For a shared provider, the delivered body is byte-identical to a fixture captured from main
 *     EXCEPT that the tenant id is removed from the graph section (#716).
 *  3. A legacy shared slug that produces a git-invalid branch fails closed PER CONSUMER at the
 *     delivery boundary (a named, non-retryable `branch_name_invalid`) instead of crashing the
 *     whole run; the change and its findings still persist.
 */
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertProvider,
  insertApiVersion,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  listChanges,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { MockGitHubDelivery, type GitHubDelivery } from "@mendpoint/github";
import { openGraphLearnMemory, resetGraphLearnDbForTests, type GraphLearnDb } from "@mendpoint/graph-learn";
import { runChangePipeline } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const acme = join(root, "fixtures/providers/acme-payments");
const shop = join(root, "fixtures/consumers/shop-app");
const mainFixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/shared-provider-pr-body.main.json"), "utf8"),
) as { tenantId: string; slug: string; captured: { title: string; body: string; branch: string; deliveryKey: string } };

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const graphDbs: GraphLearnDb[] = [];

afterEach(() => {
  resetGraphLearnDbForTests();
  while (graphDbs.length) { try { graphDbs.pop()?.raw.close(); } catch { /* ignore */ } }
  while (dbs.length) { try { dbs.pop()?.raw.close?.(); } catch { /* ignore */ } }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } }
  }
});

type Delivered = { title: string; body: string; branch: string; deliveryKey: string; fileContents: string };

/** Run the full pipeline for one provider+consumer and capture what a delivery would write. */
async function deliverOnce(input: {
  tenantId: string;
  slug: string;
  providerTenantId: string | null;
}): Promise<{ delivered?: Delivered; prStatus?: string; deliveryError?: string; changeId: string }> {
  const dir = join(tmpdir(), `mp-pubid-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  dbs.push(db);
  const providerId = newId();
  insertProvider(db, {
    id: providerId,
    slug: input.slug,
    name: "Acme Payments",
    website: null,
    tenantId: input.providerTenantId,
    createdAt: nowIso(),
  });
  for (const [versionLabel, file, publishedAt] of [
    ["1.0.0", "openapi-v1.json", "2026-01-01T00:00:00.000Z"],
    ["2.0.0", "openapi-v2.json", "2026-07-01T00:00:00.000Z"],
  ] as const) {
    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel,
      openapiJson: readFileSync(join(acme, file), "utf8"),
      changelogMd: null,
      publishedAt,
    });
  }
  const consumerId = newId();
  insertConsumer(db, {
    id: consumerId,
    name: "Shop",
    githubOwner: "org",
    githubRepo: "shop",
    installationId: null,
    tenantId: input.tenantId,
    createdAt: nowIso(),
  });
  insertConsumerRepo(db, { id: newId(), consumerId, localPath: shop, defaultBranch: "main", createdAt: nowIso() });
  insertMonitoredApi(db, { id: newId(), consumerId, providerId, detectionSource: "manual" });

  let delivered: Delivered | undefined;
  const graphDb = openGraphLearnMemory();
  graphDbs.push(graphDb);
  class Rec extends MockGitHubDelivery {
    override async deliverAdoptiveDraft(
      draftInput: Parameters<NonNullable<GitHubDelivery["deliverAdoptiveDraft"]>>[0],
      options: Parameters<NonNullable<GitHubDelivery["deliverAdoptiveDraft"]>>[1],
    ): ReturnType<NonNullable<GitHubDelivery["deliverAdoptiveDraft"]>> {
      const body = await options.resolveBody();
      delivered = {
        title: draftInput.title,
        body,
        branch: draftInput.branch,
        deliveryKey: draftInput.deliveryKey,
        fileContents: draftInput.files
          .map((f) => ("content" in f ? f.content : ""))
          .join("\n"),
      };
      return super.deliverAdoptiveDraft(draftInput, options);
    }
  }
  const report = await runChangePipeline({
    tenantId: input.tenantId,
    providerSlug: input.slug,
    db,
    graphDb,
    github: new Rec(join(dir, "gh")),
    persistIndex: false,
    contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
    securityScanAttested: true,
  });
  return {
    delivered,
    prStatus: report.consumers[0]?.prStatus,
    deliveryError: report.consumers[0]?.deliveryError,
    changeId: report.changeId,
  };
}

/** Mask run-specific ids so two independent runs' bodies can be compared byte for byte. */
function normalizeVolatile(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/[0-9a-f]{64}/gi, "<H64>")
    .replace(/[0-9a-f]{40}/gi, "<H40>")
    .replace(/[0-9a-f]{16}/gi, "<H16>");
}

describe("public-identity projection at the delivery boundary", () => {
  it("delivers a tenant-private provider with no tenant id or `~` in any customer-visible string", async () => {
    // A realistic self-serve tenant id: a 64-char sha256 hex. Stored slug is namespaced.
    const tenantId = "f".repeat(64);
    const slug = `${tenantId}~acme-payments`;
    const { delivered, prStatus } = await deliverOnce({ tenantId, slug, providerTenantId: tenantId });

    expect(prStatus, "the private provider must deliver a draft").toBe("draft");
    expect(delivered, "a draft must have been delivered").toBeDefined();
    const d = delivered!;
    // The commit message the transport builds is title + delivery key (never the slug).
    const commitMessage = `${d.title}\n\nMendpoint-Delivery: ${d.deliveryKey}`;
    for (const [name, value] of [
      ["title", d.title],
      ["body", d.body],
      ["branch", d.branch],
      ["commitMessage", commitMessage],
      ["fileContents", d.fileContents],
    ] as const) {
      expect(value.includes(tenantId), `${name} must not contain the tenant id`).toBe(false);
      expect(value.includes("~"), `${name} must not contain the '~' namespace separator`).toBe(false);
    }
    // The public slug is still present in the body (the projection strips only the namespace).
    expect(d.body).toContain("acme-payments");
  });

  it("keeps a shared provider's body byte-identical to main except the tenant id is removed (#716)", async () => {
    const { delivered, prStatus } = await deliverOnce({
      tenantId: mainFixture.tenantId,
      slug: mainFixture.slug,
      providerTenantId: null,
    });
    expect(prStatus).toBe("draft");
    const headBody = delivered!.body;

    // The shared body no longer carries the tenant id anywhere.
    expect(headBody.includes(`${mainFixture.tenantId}:`)).toBe(false);

    // Main's body with the tenant scope removed from the graph section must equal head's body,
    // once run-specific ids are masked. The tenant id is the only difference (#716).
    const expected = normalizeVolatile(mainFixture.captured.body).split(`${mainFixture.tenantId}:`).join("");
    expect(normalizeVolatile(headBody)).toBe(expected);
  });

  it("normalization is complete: two independent head runs of the shared body are equal after masking", async () => {
    const a = await deliverOnce({ tenantId: mainFixture.tenantId, slug: mainFixture.slug, providerTenantId: null });
    const b = await deliverOnce({ tenantId: mainFixture.tenantId, slug: mainFixture.slug, providerTenantId: null });
    expect(normalizeVolatile(a.delivered!.body)).toBe(normalizeVolatile(b.delivered!.body));
  });

  it("fails a legacy git-invalid shared slug closed at the delivery boundary, not by crashing the run", async () => {
    const { delivered, prStatus, deliveryError, changeId } = await deliverOnce({
      tenantId: "tenant_default",
      slug: "legacy slug", // a space is forbidden by git check-ref-format
      providerTenantId: null,
    });
    // The run completed and the analysis persisted (a change was recorded) — main crashed here.
    expect(changeId).toBeTruthy();
    expect(listChanges(db_of_last()).map((c) => c.id)).toContain(changeId);
    // Delivery for that consumer failed closed with the named, non-retryable code; nothing shipped.
    expect(delivered).toBeUndefined();
    expect(prStatus).toBe("delivery_blocked");
    expect(deliveryError).toBe("branch_name_invalid");
  });
});

/** The db created by the most recent deliverOnce (kept in the shared close list). */
function db_of_last(): ReturnType<typeof createDb> {
  return dbs[dbs.length - 1] as ReturnType<typeof createDb>;
}
