import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      "# Regauge — the first AI Legacy Engineer",
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
});
