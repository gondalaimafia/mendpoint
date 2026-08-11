import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("Mendpoint brand contract", () => {
  it("renders the website arrow mark with the approved gradient", () => {
    const html = renderToStaticMarkup(<BrandMark />);

    expect(html).toContain("Mendpoint arrow mark");
    expect(html).toContain("#356cff");
    expect(html).toContain("#00bcc1");
    expect(html).not.toContain("#34d399");
  });

  it("uses the website color and typography tokens", () => {
    const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

    expect(css).toContain("--accent: #356cff");
    expect(css).toContain("--cyan: #00bcc1");
    expect(css).toContain("--success: #22c55e");
    expect(css).toContain("--font: var(--font-inter)");
    expect(css).toContain("--display: var(--font-sora)");
    expect(css).toContain("--mono: var(--font-jetbrains-mono)");
    expect(css).not.toContain("--accent: #34d399");
  });
});
