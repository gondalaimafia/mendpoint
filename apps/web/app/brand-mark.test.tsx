import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };

  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

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

    expect(css).toContain("--brand-primary: #356cff");
    expect(css).toContain("--accent: #7698ff");
    expect(css).toContain("--cyan: #00bcc1");
    expect(css).toContain("--success: #22c55e");
    expect(css).toContain("--font: var(--font-inter)");
    expect(css).toContain("--display: var(--font-sora)");
    expect(css).toContain("--mono: var(--font-jetbrains-mono)");
    expect(css).not.toContain("--brand-primary: #34d399");
  });

  it("keeps filled primary actions above the WCAG AA contrast threshold", () => {
    const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
    const actionBlue = css.match(/--accent-action:\s*(#[0-9a-f]{6})/i)?.[1];
    const actionHover = css.match(/--accent-action-hover:\s*(#[0-9a-f]{6})/i)?.[1];

    expect(actionBlue).toBeDefined();
    expect(actionHover).toBeDefined();
    expect(contrastRatio("#ffffff", actionBlue!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", actionHover!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps accent text above the WCAG AA contrast threshold on product surfaces", () => {
    expect(contrastRatio("#7698ff", "#070a18")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#7698ff", "#0d1124")).toBeGreaterThanOrEqual(4.5);
  });
});
