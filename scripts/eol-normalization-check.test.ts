import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BINARY_EXTENSIONS,
  blobHasCr,
  classifyPath,
  extensionOf,
  scanIndexForCrlf,
} from "./eol-normalization-check.js";

describe("extensionOf", () => {
  it("lowercases the final extension", () => {
    expect(extensionOf("docs/INVESTOR_ONE_PAGER.PDF")).toBe("pdf");
    expect(extensionOf("packages/ops/src/telemetry.ts")).toBe("ts");
  });

  it("returns empty for dotfiles and extensionless names", () => {
    expect(extensionOf(".gitattributes")).toBe("");
    expect(extensionOf("scripts/run")).toBe("");
    expect(extensionOf("a/b.c/LICENSE")).toBe("");
  });
});

describe("classifyPath", () => {
  it("treats an explicit -text file as binary regardless of extension", () => {
    expect(classifyPath("docs/authority/Prompt.md", "unset")).toBe("binary");
  });

  it("treats known binary extensions as binary", () => {
    expect(classifyPath("docs/x.pdf", "auto")).toBe("binary");
    expect(classifyPath("assets/logo.png", "unspecified")).toBe("binary");
  });

  it("treats source files as text under any non-unset attribute", () => {
    expect(classifyPath("packages/ops/src/telemetry.ts", "set")).toBe("text");
    expect(classifyPath("package-lock.json", "auto")).toBe("text");
    expect(classifyPath("scripts/x.mjs", "unspecified")).toBe("text");
  });

  it("does NOT let the NUL-fooled auto/unspecified heuristic force binary", () => {
    // A NUL-bearing .ts resolves to text via its explicit `text eol=lf` rule,
    // but even the bare heuristic value must keep it text — extension decides.
    expect(classifyPath("evals/context-benchmark/live-arm.ts", "auto")).toBe("text");
  });

  it("routes every denylisted extension to binary through classifyPath", () => {
    // Asserting BINARY_EXTENSIONS.has("pdf") only restated the source; it held
    // even if classifyPath stopped consulting the set. Go through the function.
    const misclassified = [...BINARY_EXTENSIONS].filter(
      (ext) => classifyPath(`assets/file.${ext}`, "auto") !== "binary",
    );
    expect(misclassified).toEqual([]);
  });
});

describe("blobHasCr", () => {
  it("passes LF-only content", () => {
    expect(blobHasCr(Buffer.from("const x = 1;\nconst y = 2;\n", "utf8"))).toBe(false);
  });

  it("flags CRLF content", () => {
    expect(blobHasCr(Buffer.from("const x = 1;\r\nconst y = 2;\r\n", "utf8"))).toBe(true);
  });

  it("flags CRLF even when a NUL byte is present (heuristic would call it binary)", () => {
    const withNulAndCrlf = Buffer.concat([
      Buffer.from("const k = `${name}", "utf8"),
      Buffer.from([0x00]),
      Buffer.from("${json}`;\r\n", "utf8"),
    ]);
    expect(withNulAndCrlf.includes(0x00)).toBe(true);
    expect(blobHasCr(withNulAndCrlf)).toBe(true);
  });
});

describe("scanIndexForCrlf against a purpose-built index", () => {
  // The repository-wide case below can only ever assert that a clean tree is
  // clean, so it passes just as well when the scanner is gutted to `return []`.
  // These cases build an index that is deliberately dirty, so they fail unless
  // the scanner actually reads blobs and finds the carriage returns. They are
  // the automated form of the manual probes this gate was justified with.
  let root = "";

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "eol-scan-"));
    git("init", "--quiet");
    // Blobs must enter the index byte-for-byte, exactly as the guard assumes a
    // CRLF blob slipped past normalization on a real checkout.
    git("config", "core.autocrlf", "false");
    // The real .gitattributes, so classification here matches production rather
    // than a permissive empty default.
    copyFileSync(resolve(import.meta.dirname, "..", ".gitattributes"), join(root, ".gitattributes"));

    writeFileSync(join(root, "clean.probe"), "alpha\nbeta\ngamma\n", "utf8");
    writeFileSync(join(root, "crlf.probe"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    // NUL + CRLF: git's own text/binary heuristic calls this binary and skips
    // it, which is the exact blind spot .gitattributes cannot cover.
    writeFileSync(
      join(root, "nul-crlf.probe"),
      Buffer.concat([
        Buffer.from("const key = `${name}", "utf8"),
        Buffer.from([0x00]),
        Buffer.from("${json}`;\r\nconst other = 2;\r\n", "utf8"),
      ]),
    );
    git("add", "-A");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reports every CRLF text blob with its carriage-return count", () => {
    expect(scanIndexForCrlf(root)).toEqual([
      { path: "crlf.probe", crCount: 3 },
      { path: "nul-crlf.probe", crCount: 2 },
    ]);
  });

  it("does not report the LF-only blob or .gitattributes itself", () => {
    const reported = scanIndexForCrlf(root).map((offender) => offender.path);
    expect(reported).not.toContain("clean.probe");
    expect(reported).not.toContain(".gitattributes");
  });

  it("catches the NUL blob that git itself reports as binary", () => {
    // The contrast that justifies this check existing at all: git classifies the
    // blob as binary (`i/-text`) and `text` resolves to `unspecified`, so a
    // `text=auto` rule would skip it -- yet the scanner still finds its CRs.
    expect(git("ls-files", "--eol", "nul-crlf.probe")).toContain("i/-text");
    expect(git("check-attr", "text", "--", "nul-crlf.probe")).toContain("text: unspecified");
    expect(scanIndexForCrlf(root)).toContainEqual({ path: "nul-crlf.probe", crCount: 2 });
  });
});

describe("repository index is LF-normalized", () => {
  it("has zero CRLF text blobs in the index", () => {
    const offenders = scanIndexForCrlf();
    expect(
      offenders,
      `CRLF text blobs found in index:\n${offenders
        .map((o) => `  ${o.path} (${o.crCount} CR)`)
        .join("\n")}`,
    ).toEqual([]);
    // Scans every tracked blob in the index, so it is far slower than the
    // pure-function cases above: measured up to 5.5s on one Windows dev
    // checkout, against Vitest's 5s default. The sibling whole-repo scan at
    // third-state-check.test.ts:191 carries the same budget for the same reason.
  }, 120_000);
});
