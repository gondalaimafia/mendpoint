import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_DOCS } from "../apps/web/app/docs/catalog.js";
import {
  buildPublicDocsBundle,
  writePublicDocsBundle,
} from "./build-public-docs.js";

describe("website upload documentation bundle", () => {
  it("exports one canonical HTML and Markdown page per component", () => {
    const bundle = buildPublicDocsBundle();
    expect([...bundle.keys()].sort()).toEqual([
      "index.html",
      "manifest.json",
      "styles.css",
      ...PRODUCT_DOCS.flatMap((page) => [`${page.slug}.html`, `${page.slug}.md`]),
    ].sort());
    expect(bundle.get("fettler.html")).toContain(
      "<h1>Fettler — the first AI API Engineer</h1>",
    );
    expect(bundle.get("regauge.md")).toContain(
      "# ReGauge — the first AI Legacy Engineer",
    );
    expect([...bundle.keys()]).not.toEqual(
      expect.arrayContaining(["warden.html", "warden.md", "transformer.html", "transformer.md"]),
    );
  });

  it("uses relative canonical links and escapes catalog values", () => {
    const index = buildPublicDocsBundle().get("index.html") ?? "";
    expect(index).toContain('href="fettler.html"');
    expect(index).toContain('href="regauge.html"');
    expect(index).not.toContain('href="warden.html"');
    expect(index).not.toContain('href="transformer.html"');
    expect(index).not.toContain("https://www.mendpoint.ai/docs/");
    expect(index).not.toMatch(/<script|javascript:/i);
  });

  it("keeps generated scrollable quickstarts keyboard focusable and named", () => {
    const bundle = buildPublicDocsBundle();
    const index = bundle.get("index.html") ?? "";
    expect(index).toContain(
      '<pre aria-label="Quickstart command" tabindex="0"><code>npm install',
    );

    for (const page of PRODUCT_DOCS) {
      const generated = bundle.get(`${page.slug}.html`) ?? "";
      if (page.startHere.command) {
        expect(generated).toContain(
          `<pre aria-label="${page.title} quickstart command" tabindex="0"><code>`,
        );
      } else {
        expect(generated).not.toContain("<pre");
      }
    }
  });

  it("keeps every generated relative documentation link inside the bundle", () => {
    const bundle = buildPublicDocsBundle();
    for (const [name, content] of bundle) {
      if (!name.endsWith(".html") && !name.endsWith(".md")) continue;
      const links = [...content.matchAll(/(?:href=\"|\]\(\.\/)([^\"\)]+)(?:\"|\))/g)].map((match) => match[1]!);
      for (const link of links) {
        if (link.startsWith("#")) continue;
        expect(bundle.has(link), `${name}: ${link}`).toBe(true);
      }
    }
  });

  it("exports requirement, claim, and source lineage in the machine manifest", () => {
    const manifest = JSON.parse(buildPublicDocsBundle().get("manifest.json") ?? "null") as {
      schemaVersion: string;
      pages: Array<{
        requirementIds: string[];
        claimIds: string[];
        sourceContracts: string[];
        publicationEvidence: { state: string; deployedRevision: string | null; evidenceDigest: string | null };
      }>;
    };
    expect(manifest.schemaVersion).toBe("2026-08-30.v3");
    for (const page of manifest.pages) {
      expect(page.requirementIds.length).toBeGreaterThan(0);
      expect(page.sourceContracts.length).toBeGreaterThan(0);
      expect(page.claimIds).toBeInstanceOf(Array);
      expect(page.publicationEvidence).toEqual({
        state: "not_live",
        deployedRevision: null,
        evidenceDigest: null,
      });
    }
  });

  it("fails check mode on stale output and safely removes it in write mode", async () => {
    const output = await mkdtemp(join(tmpdir(), "mendpoint-public-docs-"));
    await writePublicDocsBundle(false, output);
    await writeFile(join(output, "warden.html"), "obsolete", "utf8");

    await expect(writePublicDocsBundle(true, output)).rejects.toThrow(
      "public_docs_bundle_unexpected_files:warden.html",
    );

    await writePublicDocsBundle(false, output);
    await expect(readFile(join(output, "warden.html"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(writePublicDocsBundle(true, output)).resolves.toBeUndefined();
  });

  it("rejects non-file output entries without removing them", async () => {
    const output = await mkdtemp(join(tmpdir(), "mendpoint-public-docs-"));
    await writeFile(
      join(output, ".mendpoint-public-docs-owner"),
      "Mendpoint public documentation bundle\n",
      "utf8",
    );
    await mkdir(join(output, "styles.css"));

    await expect(writePublicDocsBundle(true, output)).rejects.toThrow(
      "public_docs_bundle_unexpected_entries:styles.css",
    );
    await expect(writePublicDocsBundle(false, output)).rejects.toThrow(
      "public_docs_bundle_unexpected_entries:styles.css",
    );
  });

  it("accepts the ownership sentinel after Git checks it out with Windows line endings", async () => {
    const output = await mkdtemp(join(tmpdir(), "mendpoint-public-docs-"));
    await writePublicDocsBundle(false, output);
    await writeFile(
      join(output, ".mendpoint-public-docs-owner"),
      "Mendpoint public documentation bundle\r\n",
      "utf8",
    );

    await expect(writePublicDocsBundle(true, output)).resolves.toBeUndefined();
  });

  it("refuses to take ownership of a non-empty output directory", async () => {
    const output = await mkdtemp(join(tmpdir(), "mendpoint-public-docs-"));
    const unrelated = join(output, "unrelated.txt");
    await writeFile(unrelated, "keep me", "utf8");

    await expect(writePublicDocsBundle(true, output)).rejects.toThrow(
      "public_docs_bundle_owner_missing",
    );
    await expect(writePublicDocsBundle(false, output)).rejects.toThrow(
      "public_docs_bundle_owner_missing",
    );
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep me");
  });

  it("rejects an output-root junction before touching its target", async ({ skip }) => {
    const sandbox = await mkdtemp(join(tmpdir(), "mendpoint-public-docs-junction-"));
    const boundary = join(sandbox, "repo-docs");
    const victim = join(sandbox, "victim");
    const output = join(boundary, "website-upload");
    await mkdir(boundary);
    await mkdir(victim);
    const victimFile = join(victim, "keep.txt");
    await writeFile(victimFile, "do not touch", "utf8");
    try {
      await symlink(victim, output, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        skip();
        return;
      }
      throw error;
    }

    await expect(writePublicDocsBundle(false, output, boundary)).rejects.toThrow(
      "public_docs_bundle_reparse_point",
    );
    await expect(readFile(victimFile, "utf8")).resolves.toBe("do not touch");
  });

  it("rejects a junction in the output path before touching its target", async ({ skip }) => {
    const sandbox = await mkdtemp(join(tmpdir(), "mendpoint-public-docs-ancestor-"));
    const boundary = join(sandbox, "repo-docs");
    const victim = join(sandbox, "victim");
    const linkedAncestor = join(boundary, "linked");
    const output = join(linkedAncestor, "website-upload");
    await mkdir(boundary);
    await mkdir(join(victim, "website-upload"), { recursive: true });
    const victimFile = join(victim, "website-upload", "keep.txt");
    await writeFile(victimFile, "do not touch", "utf8");
    try {
      await symlink(victim, linkedAncestor, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        skip();
        return;
      }
      throw error;
    }

    await expect(writePublicDocsBundle(false, output, boundary)).rejects.toThrow(
      "public_docs_bundle_reparse_point",
    );
    await expect(readFile(victimFile, "utf8")).resolves.toBe("do not touch");
  });
});
