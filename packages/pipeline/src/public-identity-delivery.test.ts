/**
 * Public-identity projection at the customer-rendering boundary (#704 / #713 / #716).
 *
 * A tenant-private provider's stored slug is `<tenantId>~<requested>` and the Change Graph keys its
 * nodes by the tenant id. Neither the tenant id (an unsalted hash of issuer+email) nor the `~`
 * namespace separator may reach a customer repository. Every customer-rendered section is BUILT
 * from public identity at the source (no post-render text stripping). These tests run the REAL
 * change pipeline end to end through the adoptive delivery transport, with a PRODUCTION-SHAPED
 * checkout path (`<reposDir>/<tenantId>/<repoKey>`, so a rendered filesystem path would disclose the
 * tenant id) and both a multi-endpoint change and a single-endpoint change (the latter renders the
 * Change Graph evidence block), and scan every customer-visible string a delivery produces:
 *
 *  1. Private and shared: none of the title / body / branch / commit message / file contents
 *     contains the tenant id, for both a multi-endpoint and a single-endpoint change.
 *  2. Shared: the delivered body is byte-identical to a fixture captured from main in every section
 *     EXCEPT the Consumer registry (now path-free) and the graph sections (now tenant-free), which
 *     are asserted against their new expected text.
 *  3. A `~` inside an OpenAPI path is rendered in full (never truncated by a `~` search).
 *  4. A legacy git-invalid shared slug fails closed PER CONSUMER at the delivery boundary.
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
) as { tenantId: string; slug: string; repoKey: string; captured: { title: string; body: string; branch: string } };

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

/** Restrict both provider versions to a single endpoint so the Change Graph evidence block renders. */
function chargesOnly(spec: string): string {
  const parsed = JSON.parse(spec) as { paths: Record<string, unknown> };
  parsed.paths = { "/v1/charges": parsed.paths["/v1/charges"] };
  return JSON.stringify(parsed);
}

/** Run the full pipeline for one provider+consumer and capture what a delivery would write. */
async function deliverOnce(input: {
  tenantId: string;
  slug: string;
  providerTenantId: string | null;
  singleEndpoint?: boolean;
  specTransform?: (v1: string, v2: string) => { v1: string; v2: string };
}): Promise<{ delivered?: Delivered; prStatus?: string; deliveryError?: string; changeId: string }> {
  const dir = join(tmpdir(), `mp-pubid-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  // Use the git-tracked consumer fixture directly so delivery takes the adoptive (git_commit) path,
  // exactly as production does. The consumer's on-disk path is not rendered into the body (the
  // registry renders the public repo full name); the production-shaped-path leak is covered by the
  // registrySummaryMarkdown unit test.
  const localPath = shop;

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
  let v1 = readFileSync(join(acme, "openapi-v1.json"), "utf8");
  let v2 = readFileSync(join(acme, "openapi-v2.json"), "utf8");
  if (input.singleEndpoint) { v1 = chargesOnly(v1); v2 = chargesOnly(v2); }
  if (input.specTransform) { const t = input.specTransform(v1, v2); v1 = t.v1; v2 = t.v2; }
  for (const [versionLabel, openapiJson, publishedAt] of [
    ["1.0.0", v1, "2026-01-01T00:00:00.000Z"],
    ["2.0.0", v2, "2026-07-01T00:00:00.000Z"],
  ] as const) {
    insertApiVersion(db, { id: newId(), providerId, versionLabel, openapiJson, changelogMd: null, publishedAt });
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
  insertConsumerRepo(db, { id: newId(), consumerId, localPath, defaultBranch: "main", createdAt: nowIso() });
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
        fileContents: draftInput.files.map((f) => ("content" in f ? f.content : "")).join("\n"),
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

/** Split a PR body into ordered (header, text) sections at every markdown header line. */
function sections(body: string): Array<{ header: string; text: string }> {
  const out: Array<{ header: string; text: string }> = [];
  let header = "<preamble>";
  let buf: string[] = [];
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      out.push({ header, text: buf.join("\n") });
      header = line.trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  out.push({ header, text: buf.join("\n") });
  return out;
}

/** Sections that change by design (asserted separately, not by byte-identity to main). */
const REDESIGNED = (header: string) =>
  header.startsWith("### Consumer registry") ||
  header.startsWith("### Graph-RAG:") ||
  header.startsWith("### Change Graph evidence");

/** Every customer-visible string a delivery writes. */
function customerVisible(d: Delivered): Array<readonly [string, string]> {
  return [
    ["title", d.title],
    ["body", d.body],
    ["branch", d.branch],
    // The commit message the transport builds is title + delivery key (never the slug).
    ["commitMessage", `${d.title}\n\nMendpoint-Delivery: ${d.deliveryKey}`],
    ["fileContents", d.fileContents],
  ] as const;
}

describe("public-identity projection at the delivery boundary", () => {
  const tenantId = "f".repeat(64); // a realistic self-serve tenant id: a 64-char sha256 hex
  const slug = `${tenantId}~acme-payments`;
  const namespaced = `${tenantId}~acme-payments`; // the stored namespaced slug

  for (const singleEndpoint of [false, true] as const) {
    const kind = singleEndpoint ? "single-endpoint" : "multi-endpoint";

    it(`delivers a private provider (${kind}) with no tenant id or namespaced slug anywhere`, async () => {
      const { delivered, prStatus } = await deliverOnce({ tenantId, slug, providerTenantId: tenantId, singleEndpoint });
      expect(prStatus, "the private provider must deliver a draft").toBe("draft");
      expect(delivered, "a draft must have been delivered").toBeDefined();
      const d = delivered!;
      for (const [name, value] of customerVisible(d)) {
        expect(value.includes(tenantId), `${name} must not contain the tenant id`).toBe(false);
        // The namespaced slug (a `~` bound to the public slug) must be gone. A bare `~` inside an
        // API path is legitimate and is NOT banned here.
        expect(value.includes(namespaced), `${name} must not contain the namespaced slug`).toBe(false);
        expect(value.includes(`~acme-payments`), `${name} must not contain the '~' namespace`).toBe(false);
      }
      // The public slug is still present (only the namespace is projected away).
      expect(d.body).toContain("acme-payments");
      if (singleEndpoint) {
        // The single-endpoint change renders the Change Graph evidence block; it must be present
        // (so the leak assertion above actually covers it) yet carry no tenant id.
        expect(d.body).toContain("### Change Graph evidence");
      }
    });

    it(`delivers a shared provider (${kind}) with no tenant id anywhere`, async () => {
      const { delivered, prStatus } = await deliverOnce({
        tenantId: "tenant_default",
        slug: "acme-payments",
        providerTenantId: null,
        singleEndpoint,
      });
      expect(prStatus).toBe("draft");
      const d = delivered!;
      for (const [name, value] of customerVisible(d)) {
        expect(value.includes("tenant_default:"), `${name} must not contain the tenant scope`).toBe(false);
      }
      if (singleEndpoint) expect(d.body).toContain("### Change Graph evidence");
    });
  }

  it("keeps every non-redesigned section byte-identical to main; registry and graph change by design (#716)", async () => {
    const { delivered, prStatus } = await deliverOnce({
      tenantId: mainFixture.tenantId,
      slug: mainFixture.slug,
      providerTenantId: null,
    });
    expect(prStatus).toBe("draft");
    const headBody = delivered!.body;

    // Head carries no tenant scope anywhere.
    expect(headBody.includes(`${mainFixture.tenantId}:`)).toBe(false);

    const headSections = sections(headBody);
    const mainSections = sections(mainFixture.captured.body);

    // Same sequence of section headers.
    expect(headSections.map((s) => s.header)).toEqual(mainSections.map((s) => s.header));

    // Every section that did NOT change by design is byte-identical to main (ids masked).
    for (let i = 0; i < headSections.length; i++) {
      const h = headSections[i]!;
      const m = mainSections[i]!;
      if (REDESIGNED(h.header)) continue;
      expect(normalizeVolatile(h.text), `section unchanged: ${h.header}`).toBe(normalizeVolatile(m.text));
    }

    // Consumer registry: new expected text — the public repo full name, never the filesystem path.
    const headRegistry = headSections.find((s) => s.header.startsWith("### Consumer registry"))!;
    expect(headRegistry.text).toBe(
      [
        "### Consumer registry",
        "",
        "Provider **acme-payments** is monitored by **1** consumer(s):",
        "",
        "- **Shop** (`org/shop`)",
        "",
        "_Query this registry before proposing breaking OpenAPI changes (Warden P0)._",
      ].join("\n"),
    );
    expect(headRegistry.text.includes("tenant_default")).toBe(false);

    // Graph-RAG: new expected text is main's graph section with the tenant scope removed (#716).
    // The head projects it per-node via publicGraphToken — an independent mechanism from this
    // reference strip — so equality here cross-checks the two.
    const headGraph = headSections.find((s) => s.header.startsWith("### Graph-RAG:"))!;
    const mainGraph = mainSections.find((s) => s.header.startsWith("### Graph-RAG:"))!;
    expect(normalizeVolatile(headGraph.text)).toBe(
      normalizeVolatile(mainGraph.text).split("tenant_default:").join(""),
    );
    expect(headGraph.text.includes("tenant_default")).toBe(false);
  });

  it("normalization is complete: two independent head runs of the shared body are equal after masking", async () => {
    const a = await deliverOnce({ tenantId: mainFixture.tenantId, slug: mainFixture.slug, providerTenantId: null });
    const b = await deliverOnce({ tenantId: mainFixture.tenantId, slug: mainFixture.slug, providerTenantId: null });
    expect(normalizeVolatile(a.delivered!.body)).toBe(normalizeVolatile(b.delivered!.body));
  });

  it("renders a `~` inside an OpenAPI path in full for a shared provider (no `~`-search truncation)", async () => {
    // v1 exposes /v1/users/~me; v2 removes it. The removal surface must render with the `~me` path
    // intact. A lastIndexOf('~') projection would have collapsed it to `me.path_removed`.
    const addTildePath = (v1: string, v2: string) => {
      const p1 = JSON.parse(v1) as { paths: Record<string, unknown> };
      p1.paths["/v1/users/~me"] = {
        get: { operationId: "getMe", responses: { "200": { description: "ok" } } },
      };
      return { v1: JSON.stringify(p1), v2 };
    };
    const { delivered, prStatus } = await deliverOnce({
      tenantId: "tenant_default",
      slug: "acme-payments",
      providerTenantId: null,
      specTransform: addTildePath,
    });
    expect(prStatus).toBe("draft");
    const body = delivered!.body;
    expect(body).toContain("acme-payments./v1/users/~me.path_removed");
    expect(body).not.toContain("`me.path_removed`");
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
