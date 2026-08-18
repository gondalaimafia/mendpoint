import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxStatus } from "./sandbox-status.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/status sandbox reporting", () => {
  it("reports the effective sandbox kind when configured", () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly_machines");
    expect(sandboxStatus()).toEqual({
      kind: "fly_machines",
      configured: "fly_machines",
      ok: true,
    });
  });

  it("reports the local default when nothing is configured", () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "");
    const s = sandboxStatus();
    expect(s.kind).toBe("local");
    expect(s.ok).toBe(true);
  });

  it("reports an error, without falling over, on a set-but-unrecognized value", () => {
    vi.stubEnv("MENDPOINT_SANDBOX_KIND", "fly-machines");
    const s = sandboxStatus();
    expect(s.ok).toBe(false);
    expect(s.kind).toBeNull();
    expect(s.configured).toBe("fly-machines");
    expect(s.error).toMatch(/not a recognized sandbox kind/);
  });
});
