import { describe, expect, it } from "vitest";
import {
  createMemory,
  createSandbox,
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
  emitAlert,
  recentAlerts,
  clearAlerts,
  startLiveSandbox,
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

  it("lists scm providers", () => {
    expect(listScmProviders().length).toBeGreaterThanOrEqual(3);
  });

  it("emits alerts", () => {
    clearAlerts();
    emitAlert({ severity: "info", source: "test", message: "hi" });
    expect(recentAlerts().length).toBe(1);
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
});
