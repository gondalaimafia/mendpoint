import { describe, expect, it } from "vitest";
import {
  createMemory,
  createSandbox,
  clearSandboxCache,
  getSandboxCacheStats,
  evaluateCanary,
  memoryForPlanner,
  planCrossPrRollback,
  seedMemoryForAgent,
  createVmSandbox,
  detectVmCapabilities,
  estimateCost,
  can,
  parsePrincipalFromHeaders,
  listScmProviders,
  getScmAdapter,
  emitAlert,
  recentAlerts,
  clearAlerts,
  startLiveSandbox,
  permissionForRoute,
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
    const sbx = createVmSandbox({ backend: "local", cacheKey: "t1" });
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
    const sbx = createSandbox({ cacheKey: key, files: { "cached.txt": "ok" } });
    const root = sbx.root;
    sbx.dispose();
    expect(getSandboxCacheStats().some((entry) => entry.cacheKey === key)).toBe(true);
    clearSandboxCache(key);
    expect(getSandboxCacheStats().some((entry) => entry.cacheKey === key)).toBe(false);
    expect(() => createSandbox({ kind: "in_cluster" })).toThrow(/unavailable/i);
    expect(root).toBeTruthy();
  });
});
