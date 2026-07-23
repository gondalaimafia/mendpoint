import { describe, expect, it } from "vitest";
import { runCiLoop } from "./index.js";

describe("ci-loop", () => {
  it("passes dry-run without executing", async () => {
    const r = await runCiLoop({
      dryRun: true,
      commands: ["npm test"],
      maxAttempts: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.steps[0]?.output).toContain("dryRun");
  });

  it("succeeds on true command", async () => {
    const r = await runCiLoop({
      commands: [process.platform === "win32" ? "echo ok" : "true"],
      maxAttempts: 1,
    });
    expect(r.ok).toBe(true);
  });

  it("fails bounded on bad command", async () => {
    const r = await runCiLoop({
      commands: [process.platform === "win32" ? "exit 1" : "false"],
      maxAttempts: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  });
});
