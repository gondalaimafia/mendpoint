import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next/link renders as a plain anchor in node.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => React.createElement("a", { href, ...rest }, children),
}));

// SeverityForm is a client component; stub it so the server render stays pure.
vi.mock("./severity-form", () => ({ SeverityForm: () => null }));

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../../../../lib/api", () => ({
  apiGet,
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
    requestId = undefined;
  },
}));

import ChangeDetailPage from "./page";

const BASE = {
  id: "chg1",
  risk: "breaking",
  summary: "field renamed",
  createdAt: "2026-01-01T00:00:00.000Z",
  diff: { entries: [] },
  prs: [],
};

/** Render the change-detail page for a fixed change id with the given findings. */
async function renderWithFindings(findings: unknown[]): Promise<string> {
  apiGet.mockImplementation(async (path: string) =>
    path === "/changes/chg1" ? { ...BASE, findings } : { ...BASE, findings: [] },
  );
  return renderToStaticMarkup(
    await ChangeDetailPage({ params: Promise.resolve({ id: "chg1" }) }),
  );
}

describe("change detail — FET-016 provider path column", () => {
  beforeEach(() => apiGet.mockReset());

  it("renders the provider->code path for a finding and 'not computed' when absent", async () => {
    const html = await renderWithFindings([
      {
        id: "f1",
        filePath: "app.ts",
        lineStart: 10,
        symbol: "source",
        confidence: "high",
        graphPath: {
          nodes: ["client.ts", "wrapper.ts", "app.ts"],
          hops: 2,
          terminal: "anchor",
          truncated: false,
          coverage: "complete",
        },
      },
      {
        id: "f2",
        filePath: "loose.ts",
        lineStart: 3,
        symbol: "source",
        confidence: "low",
        graphPath: null,
      },
    ]);

    // The computed path is shown provider-anchor first, and absence reads as
    // "not computed" -- never as an assertion that no path exists.
    expect(html).toContain("client.ts → wrapper.ts → app.ts");
    expect(html).toContain("not computed");
    expect(html).toContain("Why (provider path)");
  });

  it("labels a truncated (cycle) path rather than presenting it as complete", async () => {
    const html = await renderWithFindings([
      {
        id: "f1",
        filePath: "app.ts",
        lineStart: 10,
        symbol: "source",
        confidence: "high",
        graphPath: {
          nodes: ["client.ts", "mid.ts", "app.ts"],
          hops: 2,
          terminal: "cycle",
          truncated: true,
          coverage: "partial",
        },
      },
    ]);

    expect(html).toContain("truncated at an import cycle");
  });
});
