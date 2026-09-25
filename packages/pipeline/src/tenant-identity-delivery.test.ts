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
import {
  MockGitHubDelivery,
  AdoptiveDraftBlockedError,
  TENANT_IDENTITY_DELIVERY_ERROR,
  type GitHubDelivery,
  type AdoptiveDraftInput,
  type AdoptiveDraftResult,
} from "@mendpoint/github";
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

  it("rewrites the server checkout path to the public owner/repo when known", () => {
    const out = renderPublicPrIdentity(MAIN_ERA_BODY, TENANT, {
      reposDir: "/srv/mendpoint/repos",
      ownerRepo: "org/shop-app",
    });
    expect(out).not.toContain(TENANT);
    expect(out).not.toContain("/srv/mendpoint/repos"); // server layout removed
    expect(out).toContain("- org/shop-app"); // #713's registry identity
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

/**
 * A controllable delivery double for the refresh accounting: it reports a
 * configured LIVE body/state and a configured ADOPT outcome, and counts adoptive
 * writes. This exercises the refresh's third-state accounting (blocker 2) — which
 * outcome each disposition produces and whether the DB row body is written — apart
 * from the real adoption state machine.
 */
type AdoptOutcome = "converge" | "foreign_head" | "closed" | "block";
function fakeRefreshDelivery(config: {
  liveBody: string;
  liveState?: "open" | "closed";
  adopt: AdoptOutcome;
}): { delivery: GitHubDelivery; adoptCalls: () => number } {
  let adoptCalls = 0;
  const notUsed = async (): Promise<never> => {
    throw new Error("refresh_delivery_method_not_expected");
  };
  const delivery = {
    deliverExactDraft: notUsed,
    createBranch: notUsed,
    commitFiles: notUsed,
    openPullRequest: notUsed,
    async getOpenPullRequest(_owner: string, _repo: string, _prNumber: number) {
      return { body: config.liveBody, state: config.liveState ?? ("open" as const), draft: true };
    },
    async deliverAdoptiveDraft(
      input: Omit<AdoptiveDraftInput, "body">,
      options: { resolveBody: () => string },
    ): Promise<AdoptiveDraftResult> {
      adoptCalls += 1;
      if (config.adopt === "block") {
        throw new AdoptiveDraftBlockedError(TENANT_IDENTITY_DELIVERY_ERROR);
      }
      const state = config.adopt === "closed" ? ("closed" as const) : ("draft" as const);
      // "converge" returns our re-rendered clean body; "foreign_head" leaves the
      // live (still-leaking) body untouched, exactly as ADOPT does on a human head.
      const body = config.adopt === "converge" ? options.resolveBody() : config.liveBody;
      return Object.freeze({
        number: 1,
        url: `https://github.com/org/${REPO_KEY}/pull/1`,
        branch: input.branch,
        title: input.title,
        draft: true,
        state,
        baseBranch: input.baseBranch,
        deliveredBaseSha: input.expectedBaseSha,
        deliveredHeadSha: "c".repeat(40),
        body,
      });
    },
  } as unknown as GitHubDelivery;
  return { delivery, adoptCalls: () => adoptCalls };
}

describe("refreshOpenDraftBodies — one-time refresh of open drafts (#724 blocker 2)", () => {
  const reposDir = "/srv/mendpoint/repos";
  function seedTenant(db: AppDb): void {
    insertTenant(db, { id: TENANT, slug: "shop-tenant", name: "Shop Tenant", createdAt: nowIso() });
  }
  function seedOpenDraft(db: AppDb): string {
    const consumerId = seedConsumer(db);
    seedDeliveredRow(db, consumerId, {
      id: "pr-open", changeId: "change-open", status: "draft", prNumber: 1, body: MAIN_ERA_BODY, branch: "mendpoint/acme-payments-v2",
    });
    return consumerId;
  }

  it("dry-run reads the live body, counts affected, and writes nothing (no adoptive write)", async () => {
    const db = freshDb();
    seedTenant(db);
    seedOpenDraft(db);
    const fake = fakeRefreshDelivery({ liveBody: MAIN_ERA_BODY, adopt: "converge" });
    const result = await refreshOpenDraftBodies({ db, reposDir, dryRun: true, deliveryFor: () => ({ delivery: fake.delivery }) });
    expect(result.tenants.find((t) => t.tenantId === TENANT)?.affected).toBe(1);
    expect(result.totalUpdated).toBe(0);
    expect(fake.adoptCalls()).toBe(0); // no write attempted in dry-run
    expect(getPr(db, "pr-open", TENANT)?.body).toContain(TENANT); // DB untouched
  });

  it("updates a converged draft once, writes the clean body, and is idempotent", async () => {
    const db = freshDb();
    seedTenant(db);
    seedOpenDraft(db);
    const first = await refreshOpenDraftBodies({
      db, reposDir, dryRun: false,
      deliveryFor: () => ({ delivery: fakeRefreshDelivery({ liveBody: MAIN_ERA_BODY, adopt: "converge" }).delivery }),
    });
    expect(first.tenants.find((t) => t.tenantId === TENANT)?.updated).toBe(1);
    const afterFirst = getPr(db, "pr-open", TENANT);
    expect(afterFirst?.body).not.toContain(TENANT);
    expect(afterFirst?.body).toContain("org/shop-app"); // checkout path -> owner/repo
    // The DB body is now clean, so a re-run's live read (still leaking here) would
    // re-converge idempotently; and the DB detection no longer flags it.
    const second = await refreshOpenDraftBodies({
      db, reposDir, dryRun: true,
      deliveryFor: () => ({ delivery: fakeRefreshDelivery({ liveBody: afterFirst!.body, adopt: "converge" }).delivery }),
    });
    expect(second.totalAffected).toBe(0);
  });

  it("does NOT count a foreign-head draft as updated and does NOT overwrite the DB body (so it stays visible)", async () => {
    const db = freshDb();
    seedTenant(db);
    seedOpenDraft(db);
    // ADOPT respects the human head: it returns the old (still-leaking) live body.
    const result = await refreshOpenDraftBodies({
      db, reposDir, dryRun: false,
      deliveryFor: () => ({ delivery: fakeRefreshDelivery({ liveBody: MAIN_ERA_BODY, adopt: "foreign_head" }).delivery }),
    });
    const tenant = result.tenants.find((t) => t.tenantId === TENANT);
    expect(tenant?.updated).toBe(0);
    expect(tenant?.skippedForeignHead).toHaveLength(1);
    // The DB row body is NOT overwritten clean, so a following dry-run still flags it.
    expect(getPr(db, "pr-open", TENANT)?.body).toContain(TENANT);
    const followUp = await refreshOpenDraftBodies({
      db, reposDir, dryRun: true,
      deliveryFor: () => ({ delivery: fakeRefreshDelivery({ liveBody: MAIN_ERA_BODY, adopt: "foreign_head" }).delivery }),
    });
    expect(followUp.totalAffected).toBe(1);
  });

  it("skips a human-edited description without attempting an adoptive write", async () => {
    const db = freshDb();
    seedTenant(db);
    seedOpenDraft(db);
    // The human added a note beyond the leaked tokens; the projected bodies differ.
    const fake = fakeRefreshDelivery({ liveBody: `${MAIN_ERA_BODY}\n\nHuman: please hold this PR.`, adopt: "converge" });
    const result = await refreshOpenDraftBodies({ db, reposDir, dryRun: false, deliveryFor: () => ({ delivery: fake.delivery }) });
    const tenant = result.tenants.find((t) => t.tenantId === TENANT);
    expect(tenant?.updated).toBe(0);
    expect(tenant?.skippedHumanEdited).toHaveLength(1);
    expect(fake.adoptCalls()).toBe(0);
    expect(getPr(db, "pr-open", TENANT)?.body).toContain(TENANT);
  });

  it("counts a re-render the guard still refuses as blocked, not updated", async () => {
    const db = freshDb();
    seedTenant(db);
    seedOpenDraft(db);
    const result = await refreshOpenDraftBodies({
      db, reposDir, dryRun: false,
      deliveryFor: () => ({ delivery: fakeRefreshDelivery({ liveBody: MAIN_ERA_BODY, adopt: "block" }).delivery }),
    });
    const tenant = result.tenants.find((t) => t.tenantId === TENANT);
    expect(tenant?.updated).toBe(0);
    expect(tenant?.blocked).toHaveLength(1);
    expect(getPr(db, "pr-open", TENANT)?.body).toContain(TENANT);
  });

  it("never counts a closed PR (state read from GitHub) as affected", async () => {
    const db = freshDb();
    seedTenant(db);
    seedOpenDraft(db);
    const result = await refreshOpenDraftBodies({
      db, reposDir, dryRun: false,
      deliveryFor: () => ({ delivery: fakeRefreshDelivery({ liveBody: MAIN_ERA_BODY, liveState: "closed", adopt: "converge" }).delivery }),
    });
    expect(result.totalAffected).toBe(0);
    expect(result.totalUpdated).toBe(0);
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
