import { describe, expect, it } from "vitest";
import nextConfig from "./next.config.js";

describe("documentation compatibility redirects", () => {
  it("redirects legacy product docs slugs to canonical names", async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toEqual(expect.arrayContaining([
      { source: "/docs/warden", destination: "/docs/fettler", permanent: true },
      { source: "/docs/warden.md", destination: "/docs/fettler.md", permanent: true },
      { source: "/docs/transformer", destination: "/docs/regauge", permanent: true },
      { source: "/docs/transformer.md", destination: "/docs/regauge.md", permanent: true },
    ]));
  });
});
