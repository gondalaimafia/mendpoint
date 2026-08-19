import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHANGE_GRAPH_AUTHORITY, GRAPHIFY_AUTHORITY, checkChangeGraphAuthority } from "./change-graph-authority-check.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(authority: Buffer, digest = createHash("sha256").update(authority).digest("hex")): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-change-graph-authority-"));
  roots.push(root);
  const authorityPath = join(root, ...CHANGE_GRAPH_AUTHORITY.path.split("/"));
  const adrPath = join(root, ...CHANGE_GRAPH_AUTHORITY.adrPath.split("/"));
  mkdirSync(dirname(authorityPath), { recursive: true });
  mkdirSync(dirname(adrPath), { recursive: true });
  writeFileSync(authorityPath, authority);
  writeFileSync(adrPath, [
    "../authority/Mendpoint_CODEX_Change_Graph_Intelligence_Prompt.md",
    digest,
  ].join("\n"));
  const graphifyAuthorityPath = join(root, ...GRAPHIFY_AUTHORITY.path.split("/"));
  const graphifyAdrPath = join(root, ...GRAPHIFY_AUTHORITY.adrPath.split("/"));
  mkdirSync(dirname(graphifyAuthorityPath), { recursive: true });
  mkdirSync(dirname(graphifyAdrPath), { recursive: true });
  const checkedInGraphify = readFileSync(join(process.cwd(), ...GRAPHIFY_AUTHORITY.path.split("/")));
  writeFileSync(graphifyAuthorityPath, checkedInGraphify);
  writeFileSync(graphifyAdrPath, [
    "../authority/Codex_Master_Prompt_Integrate_Graphify_Into_the_Mendpoint_Change_Graph.md",
    GRAPHIFY_AUTHORITY.sha256,
  ].join("\n"));
  return root;
}

describe("Change Graph authority gate", () => {
  it("accepts the exact checked in authority and ADR binding", () => {
    expect(checkChangeGraphAuthority(process.cwd())).toEqual([]);
  });

  it("rejects an altered authority even when the ADR still names the expected digest", () => {
    const root = fixture(Buffer.from("altered authority", "utf8"), CHANGE_GRAPH_AUTHORITY.sha256);
    expect(checkChangeGraphAuthority(root)).toEqual([
      expect.stringContaining("authority digest mismatch"),
    ]);
  });

  it("rejects a missing ADR link or digest", () => {
    const root = fixture(Buffer.from("not the authority", "utf8"));
    const adrPath = join(root, ...CHANGE_GRAPH_AUTHORITY.adrPath.split("/"));
    writeFileSync(adrPath, "# ADR without a binding\n");
    expect(checkChangeGraphAuthority(root)).toEqual(expect.arrayContaining([
      expect.stringContaining("ADR does not link the checked in authority document"),
      expect.stringContaining("ADR does not bind the authority digest"),
    ]));
  });
});
