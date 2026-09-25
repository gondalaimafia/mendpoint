import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDb,
  insertConsumer,
  insertConsumerRepo,
  insertMigrationPr,
  insertTenant,
  persistDeliveryArtifact,
  getPr,
  type AppDb,
} from "@mendpoint/db";
import { MockGitHubDelivery } from "@mendpoint/github";
import { newId, nowIso } from "@mendpoint/shared";
import {
  retryConsumerDelivery,
  deliverConsumerDraft,
  deliveryArtifactDigest,
  refreshOpenDraftBodies,
  renderPublicPrIdentity,
} from "./index.js";

// Production-shaped: 64-hex tenant id, `<reposDir>/<tenantId>/<repoKey>` checkout path.
const TENANT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const REPO_KEY = "shop-app";
const CHECKOUT_PATH = `/srv/mendpoint/repos/${TENANT}/${REPO_KEY}`;

// A main-era stored body: tenant id in the graph binding, the `~` namespace, and
// the server checkout path — the three formats #713's text strip missed.
const MAIN_ERA_BODY = [
  "### Change Graph evidence",
  `\`\`\`json`,
  `{"provider":"acme-payments","binding":{"tenantId":"${TENANT}"}}`,
  "```",
  "### Consumer registry",
  `- ${CHECKOUT_PATH}`,
  "### Impactable surfaces",
  `- ${TENANT}~acme-payments./v1/charges`,
].join("\n");

const dirs: string[] = [];
const dbs: AppDb[] = [];

function freshDb(): AppDb {
  const dir = join(tmpdir(), `mp-724-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  dbs.push(db);
  db.raw.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function seedConsumer(db: AppDb): string {
  const consumerId = newId();
  insertConsumer(db, {
    id: consumerId,
    name: "Shop",
    githubOwner: "org",
    githubRepo: REPO_KEY,
    installationId: null,
    tenantId: TENANT,
    createdAt: nowIso(),
  });
  insertConsumerRepo(db, {
    id: newId(),
    consumerId,
    localPath: CHECKOUT_PATH,
    defaultBranch: "main",
    createdAt: nowIso(),
  });
  return consumerId;
}

function seedDeliveredRow(
  db: AppDb,
  consumerId: string,
  opts: { id: string; changeId: string; status: string; prNumber: number | null; body: string; branch: string },
): void {
  const deliveryKey = `${opts.changeId}:${consumerId}`;
  const baseSha = "b".repeat(40);
  insertMigrationPr(db, {
    id: opts.id,
    changeId: opts.changeId,
    consumerId,
    title: "Adopt Acme Payments v2",
    body: opts.body,
    branchName: opts.branch,
    status: opts.status,
    risk: "low",
    patchUnified: "diff",
    githubPrNumber: opts.prNumber ?? undefined,
    githubPrUrl: opts.prNumber ? `https://github.com/org/${REPO_KEY}/pull/${opts.prNumber}` : undefined,
    createdAt: nowIso(),
  });
  persistDeliveryArtifact(db, {
    tenantId: TENANT,
    artifactDigest: deliveryArtifactDigest(deliveryKey, "t".repeat(40), baseSha),
    deliveryKey,
    title: "Adopt Acme Payments v2",
    body: opts.body,
    treeSha: "t".repeat(40),
    parentSha: baseSha,
    filesJson: JSON.stringify([{ path: "src/client.ts", content: "export const v = 2;\n" }]),
    createdAt: nowIso(),
  });
}

afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close?.();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* Windows may hold locks briefly */
      }
    }
  }
});

describe("renderPublicPrIdentity — re-project stored text to public identity (#724)", () => {
  it("collapses the namespace, strips the checkout path segment, removes the bare id", () => {
    const out = renderPublicPrIdentity(MAIN_ERA_BODY, TENANT);
    expect(out).not.toContain(TENANT);
    expect(out).toContain("acme-payments./v1/charges"); // `<id>~acme-payments` -> public slug
    expect(out).toContain(`/srv/mendpoint/repos/${REPO_KEY}`); // `/…/<id>/shop-app` -> `/…/shop-app`
    expect(out).toContain('"tenantId":""'); // bare id removed from the JSON binding
  });

  it("is a no-op for a body that never carried the id", () => {
    const clean = "### Consumer registry\n- org/shop-app\n";
    expect(renderPublicPrIdentity(clean, TENANT)).toBe(clean);
  });
});

describe("delivery-only retry re-renders a main-era body (#724)", () => {
  it("re-renders the stored pre-#713 body clean instead of re-sending it", async () => {
    const db = freshDb();
    const consumerId = seedConsumer(db);
    seedDeliveredRow(db, consumerId, {
      id: "pr-retry",
      changeId: "change-x",
      status: "delivery_failed",
      prNumber: null,
      body: MAIN_ERA_BODY,
      branch: "mendpoint/acme-payments-v2",
    });
    const github = new MockGitHubDelivery(join(dirs[dirs.length - 1]!, "gh"));
    const outcome = await retryConsumerDelivery({
      db,
      tenantId: TENANT,
      prId: "pr-retry",
      deliveryFor: () => ({ delivery: github }),
      refreshedHeadSha: null,
      now: nowIso(),
    });
    expect(outcome.retried).toBe(true);
    expect(outcome.status).toBe("draft");
    const delivered = getPr(db, "pr-retry", TENANT);
    expect(delivered?.body).not.toContain(TENANT);
    expect(delivered?.body).toContain("acme-payments./v1/charges");
  });
});

describe("refreshOpenDraftBodies — one-time refresh of open drafts (#724)", () => {
  function seedTenant(db: AppDb): void {
    insertTenant(db, { id: TENANT, slug: "shop-tenant", name: "Shop Tenant", createdAt: nowIso() });
  }

  it("dry-run counts affected drafts per tenant and writes nothing", async () => {
    const db = freshDb();
    seedTenant(db);
    const consumerId = seedConsumer(db);
    seedDeliveredRow(db, consumerId, {
      id: "pr-open", changeId: "change-open", status: "draft", prNumber: 1, body: MAIN_ERA_BODY, branch: "mendpoint/acme-payments-v2",
    });
    const result = await refreshOpenDraftBodies({ db, reposDir: "/srv/mendpoint/repos", dryRun: true });
    const tenant = result.tenants.find((t) => t.tenantId === TENANT);
    expect(tenant?.affected).toBe(1);
    expect(result.totalUpdated).toBe(0);
    // Nothing written: the stored body still carries the id.
    expect(getPr(db, "pr-open", TENANT)?.body).toContain(TENANT);
  });

  it("updates an affected open draft once and is idempotent on re-run", async () => {
    const db = freshDb();
    seedTenant(db);
    const consumerId = seedConsumer(db);
    seedDeliveredRow(db, consumerId, {
      id: "pr-open", changeId: "change-open", status: "draft", prNumber: 1, body: MAIN_ERA_BODY, branch: "mendpoint/acme-payments-v2",
    });
    const github = new MockGitHubDelivery(join(dirs[dirs.length - 1]!, "gh"));
    const deliveryFor = () => ({ delivery: github });
    const first = await refreshOpenDraftBodies({ db, reposDir: "/srv/mendpoint/repos", dryRun: false, deliveryFor });
    expect(first.tenants.find((t) => t.tenantId === TENANT)?.updated).toBe(1);
    const afterFirst = getPr(db, "pr-open", TENANT);
    expect(afterFirst?.body).not.toContain(TENANT);
    // Re-run: the row is no longer affected (its stored body is now clean).
    const second = await refreshOpenDraftBodies({ db, reposDir: "/srv/mendpoint/repos", dryRun: false, deliveryFor });
    expect(second.totalAffected).toBe(0);
    expect(second.totalUpdated).toBe(0);
  });

  it("never touches a closed or merged PR", async () => {
    const db = freshDb();
    seedTenant(db);
    const consumerId = seedConsumer(db);
    seedDeliveredRow(db, consumerId, {
      id: "pr-closed", changeId: "change-closed", status: "closed", prNumber: 2, body: MAIN_ERA_BODY, branch: "mendpoint/closed",
    });
    seedDeliveredRow(db, consumerId, {
      id: "pr-merged", changeId: "change-merged", status: "merged", prNumber: 3, body: MAIN_ERA_BODY, branch: "mendpoint/merged",
    });
    const result = await refreshOpenDraftBodies({ db, reposDir: "/srv/mendpoint/repos", dryRun: true });
    expect(result.totalAffected).toBe(0);
    expect(getPr(db, "pr-closed", TENANT)?.body).toContain(TENANT);
    expect(getPr(db, "pr-merged", TENANT)?.body).toContain(TENANT);
  });
});

describe("the guard blocks the pipeline delivery when a re-render would still leak (#724)", () => {
  it("content_manifest delivery refuses a body carrying the tenant id", async () => {
    const db = freshDb();
    const consumerId = seedConsumer(db);
    const github = new MockGitHubDelivery(join(dirs[dirs.length - 1]!, "gh"));
    const outcome = await deliverConsumerDraft({
      db,
      tenantId: TENANT,
      prId: "pr-leak",
      changeId: "change-leak",
      isRetry: false,
      consumer: { id: consumerId, github_owner: "org", github_repo: REPO_KEY },
      defaultBranch: "main",
      deliveryKey: `change-leak:${consumerId}`,
      branchName: "mendpoint/acme-payments-v2",
      title: "Adopt Acme Payments v2",
      risk: "low",
      patch: "diff",
      // A body that still leaks the tenant id must be refused, no PR opened.
      body: `See ${CHECKOUT_PATH}`,
      files: [{ path: "src/client.ts", content: "export const v = 2;\n" }],
      baseSha: "b".repeat(40),
      commitDate: nowIso(),
      revisionKind: "content_manifest",
      shouldDeliver: true,
      terminalStatus: "gates_failed",
      coverageJson: null,
      createdAt: nowIso(),
      existingPrNumber: null,
      existingPrUrl: null,
      resolveDelivery: () => ({ delivery: github }),
      assertActive: () => {},
    });
    expect(outcome.status).toBe("delivery_blocked");
    expect(outcome.deliveryError).toBe("tenant_identity_in_customer_output");
    expect(outcome.prNumber).toBeNull();
  });

  it("adoptive delivery refuses a body carrying the tenant id (transport guard)", async () => {
    const db = freshDb();
    const consumerId = seedConsumer(db);
    const github = new MockGitHubDelivery(join(dirs[dirs.length - 1]!, "gh"));
    const outcome = await deliverConsumerDraft({
      db,
      tenantId: TENANT,
      prId: "pr-leak-adoptive",
      changeId: "change-leak-adoptive",
      isRetry: false,
      consumer: { id: consumerId, github_owner: "org", github_repo: REPO_KEY },
      defaultBranch: "main",
      deliveryKey: `change-leak-adoptive:${consumerId}`,
      branchName: "mendpoint/acme-payments-v2",
      title: "Adopt Acme Payments v2",
      risk: "low",
      patch: "diff",
      body: MAIN_ERA_BODY,
      files: [{ path: "src/client.ts", content: "export const v = 2;\n" }],
      baseSha: "b".repeat(40),
      commitDate: nowIso(),
      revisionKind: "git_commit",
      shouldDeliver: true,
      terminalStatus: "gates_failed",
      coverageJson: null,
      createdAt: nowIso(),
      existingPrNumber: null,
      existingPrUrl: null,
      resolveDelivery: () => ({ delivery: github }),
      assertActive: () => {},
    });
    // The guard throws while building the commit objects, before any ref or PR
    // write, so the delivery is blocked with no PR recorded.
    expect(outcome.status).toBe("delivery_blocked");
    expect(outcome.deliveryError).toBe("tenant_identity_in_customer_output");
    expect(outcome.prNumber).toBeNull();
    expect(getPr(db, "pr-leak-adoptive", TENANT)?.github_pr_number ?? null).toBeNull();
  });
});
