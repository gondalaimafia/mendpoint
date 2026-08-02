import { describe, expect, it } from "vitest";
import { probeKnownSdks, SDK_PROVIDER_MAP } from "./sdk-signals.js";

describe("sdk signals", () => {
  it("returns local stubs offline", async () => {
    const signals = await probeKnownSdks({ localOnly: true });
    expect(signals.length).toBe(SDK_PROVIDER_MAP.length);
    expect(signals.every((s) => s.ok && s.latestVersion === "local-stub")).toBe(true);
  });

  it("bounds concurrent SDK probes and preserves registry order", async () => {
    const packages = SDK_PROVIDER_MAP.slice(0, 4).map((entry) => entry.packageName);
    let active = 0;
    let maximumActive = 0;
    const signals = await probeKnownSdks({
      packages,
      concurrency: 2,
      probePackage: async (packageName) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return {
          ecosystem: "npm",
          packageName,
          latestVersion: "1.0.0",
          ok: true,
        };
      },
    });

    expect(maximumActive).toBe(2);
    expect(signals.map((signal) => signal.packageName)).toEqual(packages);
  });
});
