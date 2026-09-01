import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.mock("next/navigation", () => ({
  usePathname: () => "/console",
}));
vi.mock("next/link", () => ({
  default: ({ children, href, prefetch: _prefetch, ...rest }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => React.createElement("a", { href, ...rest }, children),
}));

import { Nav } from "./nav";

describe("workspace navigation", () => {
  it("uses the ReGauge initial for the compatibility route", () => {
    const html = renderToStaticMarkup(<Nav />);
    expect(html).toMatch(/nav-glyph[^>]*>F<\/span><span>Fettler runs<\/span>/);
    expect(html).toMatch(/nav-glyph[^>]*>R<\/span><span>ReGauge<\/span>/);
  });

  it("links the customer outcome metrics dashboard", () => {
    const html = renderToStaticMarkup(<Nav />);
    expect(html).toContain('href="/metrics/outcomes"');
    expect(html).toMatch(/nav-glyph[^>]*>O<\/span><span>Outcomes<\/span>/);
  });
});
