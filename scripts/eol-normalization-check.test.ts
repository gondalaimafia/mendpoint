import { describe, expect, it } from "vitest";
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

  it("has pdf in the binary denylist", () => {
    expect(BINARY_EXTENSIONS.has("pdf")).toBe(true);
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

describe("repository index is LF-normalized", () => {
  it("has zero CRLF text blobs in the index", () => {
    const offenders = scanIndexForCrlf();
    expect(
      offenders,
      `CRLF text blobs found in index:\n${offenders
        .map((o) => `  ${o.path} (${o.crCount} CR)`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
