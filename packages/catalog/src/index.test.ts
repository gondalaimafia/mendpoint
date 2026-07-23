import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { detectVendors, listCatalog, findVendorByPackage } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

describe("vendor catalog", () => {
  it("lists known vendors", () => {
    const c = listCatalog();
    expect(c.some((v) => v.slug === "stripe")).toBe(true);
    expect(c.some((v) => v.slug === "openai")).toBe(true);
  });

  it("maps npm package to vendor", () => {
    expect(findVendorByPackage("stripe", "npm")?.slug).toBe("stripe");
    expect(findVendorByPackage("@aws-sdk/client-s3", "npm")?.slug).toBe("aws-sdk");
  });

  it("detects from package.json and requirements", () => {
    const root = join(tmpdir(), `cat-${Date.now()}`);
    dirs.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { stripe: "^14.0.0", lodash: "4" } }),
    );
    writeFileSync(join(root, "requirements.txt"), "openai==1.0.0\nrequests==2.0\n");
    const hits = detectVendors(root);
    expect(hits.some((h) => h.slug === "stripe" && h.source === "package.json")).toBe(true);
    expect(hits.some((h) => h.slug === "openai")).toBe(true);
  });
});
