import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /version", () => {
  afterEach(() => {
    delete process.env.MENDPOINT_RELEASE_REVISION;
  });

  it("reports the deployed release revision", async () => {
    const revision = "a".repeat(40);
    process.env.MENDPOINT_RELEASE_REVISION = revision;
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: "mendpoint",
      revision,
    });
  });

  it("reports null when the revision is absent so 'unknown' can never read as a match", async () => {
    delete process.env.MENDPOINT_RELEASE_REVISION;
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revision: null });
  });
});
