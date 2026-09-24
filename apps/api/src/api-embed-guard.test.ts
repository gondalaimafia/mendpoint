/**
 * Embedded-mode deployment guard (tenant-isolation audit fix, review follow-up).
 *
 * MENDPOINT_API_EMBED=1 builds the API app without binding a socket, for the in-process test
 * harness (see cross-tenant-http.test.ts). If it were ever set on a real deployment the entry
 * point would run the full boot, bind no port, log nothing and exit 0 — a silent outage a
 * restart policy would never restart. The module must refuse loudly, before any boot side
 * effect, when the flag is combined with a deployment signal. This pins that refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENV_KEYS = ["MENDPOINT_API_EMBED", "MENDPOINT_DEPLOYMENT_PROFILE", "MENDPOINT_APPLICATION_DATA_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("api entry point refuses embedded mode under a deployment profile", () => {
  it("throws before any boot side effect when MENDPOINT_API_EMBED=1 and a deployment profile is set", async () => {
    process.env.MENDPOINT_API_EMBED = "1";
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
    // A valid data key so the assertion is on the guard, not an unrelated boot requirement.
    process.env.MENDPOINT_APPLICATION_DATA_KEY ??= "b".repeat(64);
    await expect(import("./server.js")).rejects.toThrow("api_embed_mode_forbidden_in_deployment");
  });
});
