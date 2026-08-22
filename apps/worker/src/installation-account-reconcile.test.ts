import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getGitHubInstallationByInstallationId,
  upsertGitHubInstallation,
  type AppDb,
} from "@mendpoint/db";
import type { InstallationAccount } from "@mendpoint/github";
import {
  createInstallationAccountFetcher,
  reconcileInstallationAccount,
  reconcileNullInstallationAccounts,
  type FetchInstallationAccount,
} from "./installation-account-reconcile.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const NOW = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-22T09:00:00.000Z";

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

function freshDb(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-installation-reconcile-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  return db;
}

/** Seed one installation. Omit accountId to reproduce the pre-migration NULL row. */
function seedInstallation(
  db: AppDb,
  overrides: Partial<{
    installationId: string;
    accountId: string | null;
    tenantId: string;
  }> = {},
): void {
  upsertGitHubInstallation(db, {
    id: `install-${overrides.installationId ?? "151614362"}`,
    installationId: overrides.installationId ?? "151614362",
    accountId: overrides.accountId ?? null,
    accountLogin: "acme",
    tenantId: overrides.tenantId ?? "tenant_default",
    repositorySelection: "selected",
    repositories: [{ id: 101, owner: "acme", name: "service" }],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function fetcherReturning(account: Partial<InstallationAccount>): FetchInstallationAccount {
  return async (installationId) => ({
    installationId,
    accountId: account.accountId ?? null,
    accountLogin: account.accountLogin ?? "acme",
    accountType: account.accountType ?? "Organization",
  });
}

describe("reconcileInstallationAccount", () => {
  it("fills a NULL account id from the value GitHub reports", async () => {
    const db = freshDb();
    seedInstallation(db, { accountId: null });
    const installation = getGitHubInstallationByInstallationId(db, "151614362")!;
    expect(installation.account_id).toBeNull();

    const result = await reconcileInstallationAccount({
      db,
      installation,
      fetchAccount: fetcherReturning({ accountId: 424242 }),
      now: () => LATER,
    });

    expect(result.outcome).toBe("filled");
    expect(result.observedAccountId).toBe("424242");
    const updated = getGitHubInstallationByInstallationId(db, "151614362")!;
    expect(updated.account_id).toBe("424242");
    expect(updated.updated_at).toBe(LATER);
  });

  it("is a no-op when the stored account id already equals GitHub's", async () => {
    const db = freshDb();
    seedInstallation(db, { accountId: "424242" });
    const installation = getGitHubInstallationByInstallationId(db, "151614362")!;

    const result = await reconcileInstallationAccount({
      db,
      installation,
      fetchAccount: fetcherReturning({ accountId: 424242 }),
      now: () => LATER,
    });

    expect(result.outcome).toBe("already_set");
    const unchanged = getGitHubInstallationByInstallationId(db, "151614362")!;
    expect(unchanged.account_id).toBe("424242");
    // No write occurred: the pre-reconcile updated_at is preserved.
    expect(unchanged.updated_at).toBe(NOW);
  });

  // This assertion is the one that dies when upsertGitHubInstallation's
  // github_installation_account_mismatch guard is deleted: without the throw the
  // COALESCE silently keeps the old id and the reconciler reports "already_set"
  // instead of "mismatch", so a real divergence goes unnoticed.
  it("raises a mismatch and never overwrites a divergent stored account id", async () => {
    const db = freshDb();
    seedInstallation(db, { accountId: "111111" });
    const installation = getGitHubInstallationByInstallationId(db, "151614362")!;

    const result = await reconcileInstallationAccount({
      db,
      installation,
      fetchAccount: fetcherReturning({ accountId: 999999 }),
      now: () => LATER,
    });

    expect(result.outcome).toBe("mismatch");
    expect(result.reason).toBe("github_installation_account_mismatch");
    const unchanged = getGitHubInstallationByInstallationId(db, "151614362")!;
    expect(unchanged.account_id).toBe("111111");
    expect(unchanged.updated_at).toBe(NOW);
  });

  it("changes nothing when GitHub cannot be reached", async () => {
    const db = freshDb();
    seedInstallation(db, { accountId: null });
    const installation = getGitHubInstallationByInstallationId(db, "151614362")!;

    const result = await reconcileInstallationAccount({
      db,
      installation,
      fetchAccount: async () => {
        throw new Error("ENOTFOUND api.github.com");
      },
      now: () => LATER,
    });

    expect(result.outcome).toBe("not_observed");
    expect(result.reason).toContain("ENOTFOUND");
    const unchanged = getGitHubInstallationByInstallationId(db, "151614362")!;
    expect(unchanged.account_id).toBeNull();
    expect(unchanged.updated_at).toBe(NOW);
  });

  it("changes nothing when GitHub reports no account id", async () => {
    const db = freshDb();
    seedInstallation(db, { accountId: null });
    const installation = getGitHubInstallationByInstallationId(db, "151614362")!;

    const result = await reconcileInstallationAccount({
      db,
      installation,
      fetchAccount: fetcherReturning({ accountId: null }),
      now: () => LATER,
    });

    expect(result.outcome).toBe("not_observed");
    expect(result.reason).toBe("github_reported_no_account_id");
    const unchanged = getGitHubInstallationByInstallationId(db, "151614362")!;
    expect(unchanged.account_id).toBeNull();
  });
});

describe("reconcileNullInstallationAccounts", () => {
  it("fills only NULL rows and is idempotent on a second run", async () => {
    const db = freshDb();
    seedInstallation(db, { installationId: "151614362", accountId: null });
    seedInstallation(db, { installationId: "202", accountId: "303" });
    const fetchAccount = vi.fn(fetcherReturning({ accountId: 424242 }));

    const first = await reconcileNullInstallationAccounts({
      db,
      tenantId: "tenant_default",
      fetchAccount,
      now: () => LATER,
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.installationId).toBe("151614362");
    expect(first[0]!.outcome).toBe("filled");
    expect(fetchAccount).toHaveBeenCalledTimes(1);

    const second = await reconcileNullInstallationAccounts({
      db,
      tenantId: "tenant_default",
      fetchAccount,
      now: () => LATER,
    });
    // Nothing is NULL anymore, so the second run reconciles nothing.
    expect(second).toHaveLength(0);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
  });

  it("never reconciles across tenants", async () => {
    const db = freshDb();
    seedInstallation(db, {
      installationId: "151614362",
      accountId: null,
      tenantId: "tenant_default",
    });
    seedInstallation(db, {
      installationId: "777",
      accountId: null,
      tenantId: "tenant_other",
    });
    const fetchAccount = vi.fn(fetcherReturning({ accountId: 424242 }));

    const results = await reconcileNullInstallationAccounts({
      db,
      tenantId: "tenant_default",
      fetchAccount,
    });

    expect(results.map((r) => r.installationId)).toEqual(["151614362"]);
    const otherTenantRow = getGitHubInstallationByInstallationId(db, "777")!;
    expect(otherTenantRow.account_id).toBeNull();
  });

  it("can be narrowed to a single installation id", async () => {
    const db = freshDb();
    seedInstallation(db, { installationId: "151614362", accountId: null });
    seedInstallation(db, { installationId: "888", accountId: null });
    const fetchAccount = vi.fn(fetcherReturning({ accountId: 424242 }));

    const results = await reconcileNullInstallationAccounts({
      db,
      tenantId: "tenant_default",
      fetchAccount,
      installationId: "151614362",
    });

    expect(results.map((r) => r.installationId)).toEqual(["151614362"]);
    expect(getGitHubInstallationByInstallationId(db, "888")!.account_id).toBeNull();
  });
});

describe("createInstallationAccountFetcher", () => {
  it("refuses to run unless GITHUB_MODE is real", () => {
    expect(() =>
      createInstallationAccountFetcher({ GITHUB_MODE: "mock" } as NodeJS.ProcessEnv),
    ).toThrow("installation_reconcile_requires_github_mode_real");
  });

  it("refuses when App credentials are missing", () => {
    expect(() =>
      createInstallationAccountFetcher({ GITHUB_MODE: "real" } as NodeJS.ProcessEnv),
    ).toThrow("github_app_credentials_missing");
  });
});
