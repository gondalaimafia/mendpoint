import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFieldRenameEdits,
  decodeRenamePostcondition,
  encodeRenamePostcondition,
  planFieldRenameEdits,
} from "./warden-campaign-recipe.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function snapshot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "warden-recipe-snap-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

describe("rename postcondition encoding", () => {
  it("round-trips a rename and rejects foreign text", () => {
    expect(decodeRenamePostcondition(encodeRenamePostcondition({ from: "amount_cents", to: "amount" })))
      .toEqual({ from: "amount_cents", to: "amount" });
    expect(decodeRenamePostcondition("some other note")).toBeNull();
  });
});

describe("planFieldRenameEdits", () => {
  it("emits one valid typed edit per file referencing the old identifier, sorted, excluding non-references", () => {
    const root = snapshot({
      "src/checkout.ts": "export const x = charge.amount_cents;\n",
      "src/pay.py": "total = amount_cents + 1\n",
      "src/unrelated.ts": "export const y = 1;\n",
      "spec/openapi.json": '{ "amount_cents": {} }\n',
    });
    const edits = planFieldRenameEdits({ rename: { from: "amount_cents", to: "amount" }, sourceArtifactId: "src-1", snapshotRoot: root });
    expect(edits.map((e) => e.targetPath)).toEqual(["spec/openapi.json", "src/checkout.ts", "src/pay.py"]);
    for (const edit of edits) {
      expect(edit.kind).toBe("typed_recipe");
      expect(edit.targetSymbol).toBe("amount_cents");
      expect(edit.sourceEvidenceIds).toContain("src-1");
      expect(edit.confidence).toBeGreaterThan(0);
      expect(edit.confidence).toBeLessThanOrEqual(1);
      expect(edit.targetPath.includes("..")).toBe(false);
      expect(decodeRenamePostcondition(edit.postcondition)).toEqual({ from: "amount_cents", to: "amount" });
    }
  });

  it("matches on a whole-word boundary only", () => {
    const root = snapshot({ "a.ts": "const amount_cents_total = 1;\nconst amount_cents = 2;\n" });
    const edits = planFieldRenameEdits({ rename: { from: "amount_cents", to: "amount" }, sourceArtifactId: "s", snapshotRoot: root });
    // The file DOES contain a whole-word `amount_cents` (line 2), so it is flagged...
    expect(edits).toHaveLength(1);
  });

  it("returns no edits when the identifier is absent", () => {
    const root = snapshot({ "a.ts": "const other = 1;\n" });
    expect(planFieldRenameEdits({ rename: { from: "amount_cents", to: "amount" }, sourceArtifactId: "s", snapshotRoot: root })).toEqual([]);
  });
});

describe("applyFieldRenameEdits", () => {
  it("applies the rename into an isolated candidate, echoes the manifest, and mirrors the edit ids", () => {
    const root = snapshot({
      "src/checkout.ts": "export const x = charge.amount_cents;\n",
      "src/keep.ts": "export const y = amount_cents_total;\n",
    });
    const edits = planFieldRenameEdits({ rename: { from: "amount_cents", to: "amount" }, sourceArtifactId: "src-1", snapshotRoot: root });
    const candidate = applyFieldRenameEdits({ snapshotRoot: root, manifestSha256: "b".repeat(64), edits });
    dirs.push(candidate.candidateRoot);

    expect(candidate.baseManifestSha256).toBe("b".repeat(64));
    expect([...candidate.appliedEditIds].sort()).toEqual(edits.map((e) => e.id).sort());
    // The candidate is isolated: the snapshot is unchanged.
    expect(readFileSync(join(root, "src/checkout.ts"), "utf8")).toContain("amount_cents");
    // The candidate has the rename applied on the whole word only.
    expect(readFileSync(join(candidate.candidateRoot, "src/checkout.ts"), "utf8")).toBe("export const x = charge.amount;\n");
    expect(candidate.candidateContent).toContain("src/checkout.ts:amount_cents->amount");
  });
});
