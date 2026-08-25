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

describe("change detail — FET-017 empty findings", () => {
  beforeEach(() => apiGet.mockReset());

  it("treats analyzed empty findings as verified no-impact", async () => {
    apiGet.mockResolvedValue({
      ...BASE,
      findings: [],
      impactCoverage: {
        impact: "no_impact",
        coverageBasis: "analyzed",
        reason: null,
        findingCount: 0,
        prCount: 1,
      },
    });
    const html = renderToStaticMarkup(
      await ChangeDetailPage({ params: Promise.resolve({ id: "chg1" }) }),
    );
    expect(html).toContain("No impact — verified");
    expect(html).not.toContain("Confirm pipeline completion");
    expect(html).not.toContain("analyzed without a tenant graph");
  });

  it("does not treat raw-retrieval no-impact as graph-authoritative", async () => {
    apiGet.mockResolvedValue({
      ...BASE,
      findings: [],
      impactCoverage: {
        impact: "no_impact",
        coverageBasis: "analyzed",
        reason: null,
        findingCount: 0,
        prCount: 1,
        fallback: "raw_retrieval",
      },
    });
    const html = renderToStaticMarkup(
      await ChangeDetailPage({ params: Promise.resolve({ id: "chg1" }) }),
    );
    expect(html).toContain("analyzed without a tenant graph");
    expect(html).not.toContain("No impact — verified");
  });

  it("notes raw retrieval when findings are present", async () => {
    apiGet.mockResolvedValue({
      ...BASE,
      findings: [
        {
          id: "f1",
          filePath: "app.ts",
          lineStart: 10,
          symbol: "source",
          confidence: "high",
          graphPath: null,
        },
      ],
      impactCoverage: {
        impact: "impact",
        coverageBasis: "analyzed",
        reason: null,
        findingCount: 1,
        prCount: 1,
        fallback: "raw_retrieval",
      },
    });
    const html = renderToStaticMarkup(
      await ChangeDetailPage({ params: Promise.resolve({ id: "chg1" }) }),
    );
    expect(html).toContain("Impact was analyzed via raw retrieval, not a tenant graph");
    expect(html).not.toContain("analyzed without a tenant graph");
  });

  it("does not treat partial coverage as verified no-impact", async () => {
    apiGet.mockResolvedValue({
      ...BASE,
      findings: [],
      impactCoverage: {
        impact: "unknown_impact",
        coverageBasis: "partial",
        reason: "partial_or_unknown_coverage",
        findingCount: 0,
        prCount: 1,
      },
    });
    const html = renderToStaticMarkup(
      await ChangeDetailPage({ params: Promise.resolve({ id: "chg1" }) }),
    );
    expect(html).toContain("No known impact under partial coverage");
    expect(html).not.toContain("No impact — verified");
  });
});

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

  it("labels a one-node no_anchor path as incomplete, never as direct provider usage", async () => {
    // A detached node has no predecessor, so a no_anchor walk can only ever
    // emit a single node with truncated=true. The renderer must not short-circuit
    // on node count alone and mislabel it "Direct provider usage".
    const html = await renderWithFindings([
      {
        id: "f1",
        filePath: "detached.ts",
        lineStart: 4,
        symbol: "source",
        confidence: "medium",
        graphPath: {
          nodes: ["detached.ts"],
          hops: 0,
          terminal: "no_anchor",
          truncated: true,
          coverage: "partial",
        },
      },
    ]);

    expect(html).toContain("incomplete: no provider anchor reached");
    expect(html).not.toContain("Direct provider usage");
  });
});
