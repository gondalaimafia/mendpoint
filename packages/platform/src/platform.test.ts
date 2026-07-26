import { describe, expect, it } from "vitest";
import {
  createMemory,
  createSandbox,
  evaluateCanary,
  memoryForPlanner,
  planCrossPrRollback,
  seedMemoryForAgent,
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
