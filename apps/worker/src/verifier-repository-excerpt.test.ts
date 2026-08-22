import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildVerifierRepositoryExcerpt } from "./verifier-repository-excerpt.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-verifier-excerpt-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "api.ts"), "export const endpoint = '/v1/responses';\n");
  return root;
}

describe("verifier repository excerpt", () => {
  it("binds exact changed candidate bytes in a bounded substantive source", () => {
    const root = workspace();
    const result = buildVerifierRepositoryExcerpt({
      candidateWorkspace: root,
      changedPaths: ["src/api.ts"],
    });

    expect(result).toMatchObject({
      locator: "src/api.ts",
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result?.content).toContain("[FILE src/api.ts]");
    expect(result?.content).toContain("/v1/responses");
  });

  it("returns no source for deletion only changes and rejects traversal", () => {
    const root = workspace();
    expect(buildVerifierRepositoryExcerpt({
      candidateWorkspace: root,
      changedPaths: ["src/deleted.ts"],
    })).toBeNull();
    expect(() => buildVerifierRepositoryExcerpt({
      candidateWorkspace: root,
      changedPaths: ["../outside.ts"],
    })).toThrow("verifier_repository_excerpt_path_invalid");
  });

  it.skipIf(process.platform === "win32")("rejects changed path symlinks", () => {
    const root = workspace();
    symlinkSync(join(root, "src", "api.ts"), join(root, "src", "link.ts"));
    expect(() => buildVerifierRepositoryExcerpt({
      candidateWorkspace: root,
      changedPaths: ["src/link.ts"],
    })).toThrow("verifier_repository_excerpt_symlink");
  });
});
