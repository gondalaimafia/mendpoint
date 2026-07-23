import { describe, expect, it } from "vitest";
import { probeKnownSdks, SDK_PROVIDER_MAP } from "./sdk-signals.js";

describe("sdk signals", () => {
  it("returns local stubs offline", async () => {
    const signals = await probeKnownSdks({ localOnly: true });
    expect(signals.length).toBe(SDK_PROVIDER_MAP.length);
    expect(signals.every((s) => s.ok && s.latestVersion === "local-stub")).toBe(true);
  });
});
