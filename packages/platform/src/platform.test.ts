import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMemory,
  createSandbox,
  clearSandboxCache,
  clearBuildCache,
  getSandboxCacheStats,
  tenantScopedCacheKey,
  evaluateCanary,
  memoryForPlanner,
  planCrossPrRollback,
  seedMemoryForAgent,
  createVmSandbox,
  detectVmCapabilities,
  estimateCost,
  can,
  canMutateSystemCatalog,
  parsePrincipalFromHeaders,
  listScmProviders,
  getScmAdapter,
  emitAlert,
  recentAlerts,
  clearAlerts,
  setAlertPersistPath,
  evaluateDogfoodAlerts,
  startLiveSandbox,
  permissionForRoute,
  type CreateSandboxOpts,
} from "./index.js";

describe("platform memory", () => {
  it("seeds warden style guide and formats planner context", () => {
    let m = createMemory();
    m = seedMemoryForAgent("warden", m);
    const text = memoryForPlanner(m);
    expect(text).toMatch(/Idempotency|pagination|Knowledge/i);
  });
});

describe("sandbox", () => {
  it("creates local workdir and runs a command", () => {
    const sbx = createSandbox({
      files: { "hello.txt": "hi" },
      mocks: [{ name: "upstream", baseUrl: "http://127.0.0.1:9" }],
    });
    try {
      const r = sbx.run("node -e \"console.log('ok')\"");
      expect(r.ok).toBe(true);
      expect(r.stdout).toMatch(/ok/);
    } finally {
      sbx.dispose();
    }
  });

  it("does not leak host process.env secrets into executed commands", () => {
    const sentinel = `sekret_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env.MENDPOINT_TEST_SECRET = sentinel;
    const sbx = createSandbox({});
    try {
      const r = sbx.run(
        "node -e \"console.log(process.env.MENDPOINT_TEST_SECRET ?? 'ABSENT')\"",
      );
      expect(r.ok).toBe(true);
      expect(r.stdout).not.toContain(sentinel);
      expect(r.stdout).toMatch(/ABSENT/);
    } finally {
      sbx.dispose();
      delete process.env.MENDPOINT_TEST_SECRET;
    }
  });
});

describe("canary", () => {
  it("holds without human approval", () => {
    const d = evaluateCanary({});
    expect(d.action).toBe("hold");
    expect(d.allowDeploy).toBe(false);
  });

  it("rollbacks on high error rate", () => {
    const d = evaluateCanary({ humanApproved: true, observedErrorRate: 0.5 });
    expect(d.action).toBe("rollback");
  });

  it("plans cross-pr rollback", () => {
    const r = planCrossPrRollback("c1", "n3", ["n1", "n2"], "parity fail");
    expect(r.upstreamNodeIds).toEqual(["n1", "n2"]);
  });
});

describe("vm + cost + rbac + scm + alerts", () => {
  it("creates vm sandbox with local backend", () => {
    const caps = detectVmCapabilities();
    expect(caps.some((c) => c.backend === "local" && c.available)).toBe(true);
    const sbx = createVmSandbox({ backend: "local", cacheKey: "t1", tenantId: "tenant-a" });
    try {
      expect(sbx.backend).toBe("local");
      const r = sbx.run("node -e \"console.log(1)\"");
      expect(r.ok).toBe(true);
    } finally {
      sbx.dispose();
    }
  });

  it("estimates cost", () => {
    const c = estimateCost({ tokensEst: 1000, sandboxMinutes: 1, graphQueries: 10 });
    expect(c.totalUsd).toBeGreaterThan(0);
  });

  it("rbac denies viewer plan:edit", () => {
    const p = parsePrincipalFromHeaders({
      "x-role": "viewer",
      "x-tenant-id": "t1",
      "x-user-id": "u1",
    });
    expect(can(p, "plan:read")).toBe(true);
    expect(can(p, "plan:edit")).toBe(false);
  });

  it("limits shared provider catalog mutations to system tenant administrators", () => {
    expect(
      canMutateSystemCatalog({
        id: "system-owner",
        tenantId: "tenant_default",
        role: "owner",
      }),
    ).toBe(true);
    expect(
      canMutateSystemCatalog({
        id: "customer-owner",
        tenantId: "tenant-customer",
        role: "owner",
      }),
    ).toBe(false);
    expect(
      canMutateSystemCatalog({
        id: "system-engineer",
        tenantId: "tenant_default",
        role: "engineer",
      }),
    ).toBe(false);
  });

  it("lists scm providers with mock mode for all", () => {
    const list = listScmProviders();
    expect(list.length).toBe(4);
    expect(list.every((p) => p.available)).toBe(true);
    expect(list.every((p) => p.mode === "live" || p.mode === "mock")).toBe(true);
  });

  it("emits alerts and can persist path", () => {
    clearAlerts({ wipeFile: false });
    emitAlert({ severity: "info", source: "test", message: "hi" });
    expect(recentAlerts().length).toBeGreaterThanOrEqual(1);
  });

  it("filters persisted alerts by exact tenant while retaining legacy unscoped alerts", () => {
    clearAlerts({ wipeFile: true });
    emitAlert({ severity: "info", source: "test", message: "legacy" });
    emitAlert({ severity: "warn", source: "test", message: "a", tenantId: "tenant-a" });
    emitAlert({ severity: "critical", source: "test", message: "b", tenantId: "tenant-b" });

    expect(recentAlerts(50, { tenantId: "tenant-a" }).map((alert) => alert.message)).toEqual(["a"]);
    expect(recentAlerts(50, { tenantId: "tenant-a", includeUnscoped: true }).map((alert) => alert.message)).toEqual(["legacy", "a"]);
    expect(() => recentAlerts(50, { tenantId: " " })).toThrow(/tenant scope required/i);
    expect(() => emitAlert({ severity: "info", source: "test", message: "blank", tenantId: " " })).toThrow(/tenant scope required/i);
  });

  it("does not emit a dogfood volume alert for an empty corpus", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-empty-corpus-"));
    try {
      setAlertPersistPath(join(dir, "alerts.jsonl"));
      clearAlerts({ wipeFile: true });

      const empty = evaluateDogfoodAlerts({
        totalRuns: 0,
        okRate: 0,
        targetRuns: 30,
        targetOkRate: 0.5,
        day90Ready: false,
        tenantId: "tenant-a",
      });
      expect(empty).toEqual([]);
      expect(recentAlerts(500, { tenantId: "tenant-a" })).toEqual([]);

      // A genuine shortfall — runs exist, just not enough — still alerts.
      const shortfall = evaluateDogfoodAlerts({
        totalRuns: 3,
        okRate: 1,
        targetRuns: 30,
        targetOkRate: 0.5,
        day90Ready: false,
        tenantId: "tenant-a",
      });
      expect(shortfall.map((alert) => alert.severity)).toEqual(["info"]);
      expect(shortfall[0]?.message).toContain("3/30");
    } finally {
      clearAlerts({ wipeFile: true });
      setAlertPersistPath(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never evicts one tenant's alerts to make room for another tenant's volume", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-evict-"));
    try {
      setAlertPersistPath(join(dir, "alerts.jsonl"));
      clearAlerts({ wipeFile: true });

      emitAlert({ severity: "warn", source: "test", message: "quiet", tenantId: "tenant-quiet" });
      // Well past the 500-entry buffer cap: under oldest-first eviction this
      // alone pushed every other tenant's alerts out of recentAlerts.
      for (let i = 0; i < 600; i++) {
        emitAlert({ severity: "info", source: "test", message: `loud-${i}`, tenantId: "tenant-loud" });
      }

      expect(recentAlerts(500, { tenantId: "tenant-quiet" }).map((alert) => alert.message)).toEqual(["quiet"]);
      expect(recentAlerts(500, { tenantId: "tenant-loud" }).length).toBeGreaterThan(0);

      // Legacy unscoped alerts are a bucket of their own and survive too.
      clearAlerts({ wipeFile: true });
      emitAlert({ severity: "info", source: "test", message: "legacy" });
      for (let i = 0; i < 600; i++) {
        emitAlert({ severity: "info", source: "test", message: `loud-${i}`, tenantId: "tenant-loud" });
      }
      expect(recentAlerts(500).some((alert) => alert.message === "legacy")).toBe(true);
    } finally {
      clearAlerts({ wipeFile: true });
      setAlertPersistPath(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts live sandbox and probes health", async () => {
    const live = await startLiveSandbox();
    try {
      expect(live.port).toBeGreaterThan(0);
      const r = await live.curl("/health");
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      expect(r.stdout).toMatch(/ok/i);
    } finally {
      live.dispose();
    }
  });

  it("gitlab mock createPr works without token", async () => {
    const gl = getScmAdapter("gitlab");
    const pr = await gl.createPr({
      owner: "o",
      repo: "r",
      title: "t",
      body: "b",
      head: "feat",
      base: "main",
    });
    expect(pr.provider).toBe("gitlab");
    expect(pr.url).toContain("gitlab");
  });

  it("permissionForRoute maps mutations", () => {
    expect(permissionForRoute("PATCH", "/platform/plans/x")).toBe("plan:edit");
    expect(permissionForRoute("POST", "/prs/1/feedback")).toBe("outcome:label");
    expect(permissionForRoute("GET", "/github/app/installations")).toBe(
      "tenant:admin",
    );
    expect(permissionForRoute("GET", "/changes/1")).toBe("graph:read");
    expect(permissionForRoute("GET", "/metrics")).toBe("graph:read");
    expect(permissionForRoute("GET", "/jobs")).toBe("graph:read");
    expect(permissionForRoute("GET", "/repair/sessions")).toBe("graph:read");
    expect(permissionForRoute("POST", "/jobs/job-1/retry")).toBe("tenant:admin");
    expect(permissionForRoute("POST", "/jobs/job-1/cancel")).toBe("tenant:admin");
    expect(permissionForRoute("GET", "/platform/scm")).toBe("tenant:admin");
    expect(permissionForRoute("GET", "/billing/usage")).toBe("tenant:admin");
    expect(permissionForRoute("POST", "/billing/usage/reservations")).toBe("tenant:admin");
    expect(permissionForRoute("POST", "/billing/execution-costs")).toBe("tenant:admin");
    expect(permissionForRoute("GET", "/transformer/control-plane/campaigns/campaign-a")).toBe("graph:read");
    expect(permissionForRoute("POST", "/transformer/control-plane/campaigns")).toBe("plan:execute");
    expect(permissionForRoute("POST", "/v1/transformer/attempt-coordinator/readyz")).toBe("transformer:worker");
    // Regauge/Fettler canonical paths resolve to the SAME permission as the
    // legacy /transformer and /warden aliases, so auth is unchanged on both.
    expect(permissionForRoute("GET", "/regauge/control-plane/campaigns/campaign-a")).toBe("graph:read");
    expect(permissionForRoute("POST", "/regauge/control-plane/campaigns")).toBe("plan:execute");
    expect(permissionForRoute("POST", "/v1/regauge/attempt-coordinator/readyz")).toBe("transformer:worker");
    expect(permissionForRoute("POST", "/fettler/plans/from-spec")).toBe("plan:execute");
    expect(permissionForRoute("POST", "/warden/plans/from-spec")).toBe("plan:execute");
    expect(permissionForRoute("GET", "/fettler/plans")).toBe("plan:read");
    expect(permissionForRoute("GET", "/warden/plans")).toBe("plan:read");
    expect(permissionForRoute("POST", "/agent/runs/run-a/candidate/review")).toBe("plan:edit");
    expect(permissionForRoute("GET", "/change-sources/source-a")).toBe("graph:read");
    expect(permissionForRoute("POST", "/change-sources")).toBe("plan:execute");
    expect(permissionForRoute("POST", "/platform/scm/connections")).toBe("tenant:admin");
    expect(permissionForRoute("GET", "/auth/sessions/current")).toBe("graph:read");
    expect(permissionForRoute("POST", "/auth/sessions/current/revoke")).toBe("graph:read");
    expect(permissionForRoute("POST", "/scim/v2/Users")).toBe("identity:provision");
    const viewer = parsePrincipalFromHeaders({ "x-role": "viewer" });
    expect(can(viewer, "plan:edit")).toBe(false);
    const invalid = parsePrincipalFromHeaders({ "x-role": "not-a-role" });
    expect(invalid.role).toBe("viewer");
    expect(can(invalid, "sandbox:run")).toBe(false);
  });

  it("keeps health probes public while protected reads fail closed", () => {
    for (const path of [
      "/",
      "/health",
      "/live",
      "/ready",
      "/version",
      "/status",
    ]) {
      expect(permissionForRoute("GET", path)).toBeNull();
      expect(permissionForRoute("HEAD", path)).toBeNull();
    }
    expect(permissionForRoute("POST", "/ready")).toBe("plan:execute");
    expect(permissionForRoute("GET", "/keys")).toBe("tenant:admin");
  });

  it("fails closed for unimplemented kinds and escaping seed paths", () => {
    expect(() => createSandbox({ kind: "vm" })).toThrow(/real backend/i);
    expect(() =>
      createSandbox({ files: { "../outside.txt": "blocked" } }),
    ).toThrow(/escapes root/i);
  });

  it("provides explicit lifecycle control for persistent cache roots", () => {
    const key = `platform-test-${Date.now()}`;
    const tenantId = "tenant-lifecycle";
    const sbx = createSandbox({ cacheKey: key, tenantId, files: { "cached.txt": "ok" } });
    const root = sbx.root;
    sbx.dispose();
    const present = getSandboxCacheStats().find(
      (entry) => entry.cacheKey === key && entry.tenantId === tenantId,
    );
    expect(present).toBeDefined();
    // Clearing is by the tenant-scoped map key, surfaced as scopedKey in stats.
    clearSandboxCache(present!.scopedKey);
    expect(
      getSandboxCacheStats().some(
        (entry) => entry.cacheKey === key && entry.tenantId === tenantId,
      ),
    ).toBe(false);
    expect(() => createSandbox({ kind: "in_cluster" })).toThrow(/unavailable/i);
    expect(root).toBeTruthy();
  });
});

describe("sandbox build cache is tenant-scoped (defect: cross-tenant cache)", () => {
  // Test fixtures only — never a real tenant's source. Nothing here is logged.
  afterAll(() => {
    clearSandboxCache();
    clearBuildCache();
  });

  it("length-prefixes the scoped key so no two tenant/key pairs can collide", () => {
    // The classic forgeable-concatenation collision: (a, 1x) and (a1, x) both
    // concatenate to a1x. Length-prefixing separates them.
    const forgeA = tenantScopedCacheKey({ tenantId: "a", cacheKey: "1x" });
    const forgeB = tenantScopedCacheKey({ tenantId: "a1", cacheKey: "x" });
    expect(forgeA).not.toBe(forgeB);
  });

  it("refuses a cache-keyed sandbox with no tenant (fail closed, no global key)", () => {
    // The pairing is a compile error; force the invalid shape to prove the
    // runtime twin also refuses rather than falling back to a shared key.
    expect(() =>
      createSandbox({ cacheKey: "orphan-key" } as unknown as CreateSandboxOpts),
    ).toThrow(/sandbox_tenant_scope_required/);
    expect(() => tenantScopedCacheKey({ cacheKey: "orphan-key" })).toThrow(
      /sandbox_tenant_scope_required/,
    );
  });

  it("gives two tenants distinct roots for one shared cacheKey and no cross-read", () => {
    const key = `shared-${Date.now()}`;
    const a = createSandbox({
      cacheKey: key,
      tenantId: "tenant-a",
      files: { "secret.txt": "tenant-a-private" },
    });
    const b = createSandbox({
      cacheKey: key,
      tenantId: "tenant-b",
      files: { "secret.txt": "tenant-b-private" },
    });
    try {
      // Distinct roots by construction — not the same directory reused.
      expect(a.root).not.toBe(b.root);
      // Each root holds only its own tenant's content: reading tenant B's handle
      // never yields tenant A's file, and vice versa. Isolation asserted directly.
      expect(readFileSync(join(a.root, "secret.txt"), "utf8")).toBe("tenant-a-private");
      expect(readFileSync(join(b.root, "secret.txt"), "utf8")).toBe("tenant-b-private");
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("reuses one tenant's cached root on a repeat (working path unbroken)", () => {
    const key = `reuse-${Date.now()}`;
    const first = createSandbox({ cacheKey: key, tenantId: "tenant-a", files: { "x.txt": "1" } });
    const firstRoot = first.root;
    first.dispose();
    const second = createSandbox({ cacheKey: key, tenantId: "tenant-a" });
    try {
      expect(second.root).toBe(firstRoot);
    } finally {
      second.dispose();
    }
  });

  it("scopes eviction to the flooding tenant and never removes another tenant's root", () => {
    const aKey = `evict-a-${Date.now()}`;
    const a = createSandbox({ cacheKey: aKey, tenantId: "tenant-a", files: { "a.txt": "a" } });
    const aRoot = a.root;
    a.dispose(); // refs -> 0, evictable only within tenant-a
    const aScoped = tenantScopedCacheKey({ cacheKey: aKey, tenantId: "tenant-a" })!;

    // Flood tenant-b past its per-tenant cap (32) with unique keys.
    for (let i = 0; i < 40; i++) {
      const s = createSandbox({
        cacheKey: `evict-b-${Date.now()}-${i}`,
        tenantId: "tenant-b",
        files: { "b.txt": "b" },
      });
      s.dispose();
    }

    // Tenant A's cached root survived tenant B's flood — its map entry and its
    // on-disk directory are both intact.
    expect(getSandboxCacheStats().some((e) => e.scopedKey === aScoped)).toBe(true);
    expect(existsSync(aRoot)).toBe(true);
  });

  it("binds the vm build cache to the tenant so a replayed cacheKey never hits", () => {
    // Mirrors what POST /platform/vm/sandbox now does: the cacheKey is scoped to
    // the authenticated tenant. A hostile tenant replaying another tenant's key
    // gets neither a cache hit (the existence oracle) nor a shared root.
    const key = `vm-shared-${Date.now()}`;
    const a = createVmSandbox({
      backend: "local",
      cacheKey: key,
      tenantId: "tenant-a",
      files: { "s.txt": "a" },
    });
    expect(a.cacheHit).toBe(false);
    const aRoot = a.root;
    a.dispose();

    // Same tenant, same key: the working cache path still hits.
    const a2 = createVmSandbox({ backend: "local", cacheKey: key, tenantId: "tenant-a" });
    expect(a2.cacheHit).toBe(true);
    expect(a2.root).toBe(aRoot);
    a2.dispose();

    // Different tenant replaying the identical key: no hit, no shared root.
    const b = createVmSandbox({
      backend: "local",
      cacheKey: key,
      tenantId: "tenant-b",
      files: { "s.txt": "b" },
    });
    try {
      expect(b.cacheHit).toBe(false);
      expect(b.root).not.toBe(aRoot);
    } finally {
      b.dispose();
    }
  });
});
