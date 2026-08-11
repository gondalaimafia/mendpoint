import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("verify egress residual-risk disclosure", () => {
  it("documents that verification runs without network isolation", () => {
    const source = readFileSync(join(here, "verify.ts"), "utf8");
    expect(source).toMatch(/network isolation/i);
    expect(source).toMatch(/egress/i);
    // The disclosure must point operators at the infra-layer gate.
    expect(source).toMatch(/SANDBOX_VERIFIER\.md/);
  });
});
