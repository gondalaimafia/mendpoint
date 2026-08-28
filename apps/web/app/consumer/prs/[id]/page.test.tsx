import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {} }),
}));

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../../../../lib/api", () => ({ apiGet }));

import PrDetailPage from "./page";

const PR = {
  id: "pr-1",
  changeId: "chg1",
  consumerId: "con1",
  title: "Migrate charge() -> charges.create()",
  body: "",
  branchName: "mendpoint/migrate",
  status: "open",
  risk: "breaking",
  patchUnified: "",
  githubPrNumber: 12,
  githubPrUrl: "https://github.com/acme/x/pull/12",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("/consumer/prs/[id] FET-016 impact lineage", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("renders the provider path for this consumer and ignores another consumer", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs/pr-1") return PR;
      if (path === "/prs/pr-1/reviews") return { reviews: [] };
      if (path === "/changes/chg1") {
        return {
          findings: [
            {
              id: "f-self",
              consumerId: "con1",
              filePath: "src/pay.ts",
              lineStart: 12,
              symbol: "charge",
              graphPath: {
                nodes: ["stripe.charges", "src/pay.ts"],
                hops: 1,
                terminal: "anchor",
                truncated: false,
                coverage: "complete",
              },
            },
            {
              id: "f-other",
              consumerId: "con-other",
              filePath: "src/other.ts",
              lineStart: 1,
              symbol: "other",
              graphPath: {
                nodes: ["stripe.charges", "src/other.ts"],
                hops: 1,
                terminal: "anchor",
                truncated: false,
                coverage: "complete",
              },
            },
          ],
          impactCoverage: {
            impact: "impact",
            coverageBasis: "analyzed",
            reason: null,
            findingCount: 2,
            prCount: 2,
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const html = renderToStaticMarkup(
      await PrDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    );
    expect(html).toContain("IMPACT LINEAGE");
    expect(html).toContain("src/pay.ts:12");
    expect(html).toContain("stripe.charges → src/pay.ts");
    expect(html).not.toContain("src/other.ts");
  });

  it("does not treat a failed change fetch as no-impact", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs/pr-1") return PR;
      if (path === "/prs/pr-1/reviews") return { reviews: [] };
      if (path === "/changes/chg1") throw new Error("API /changes/chg1 returned 500");
      throw new Error(`unexpected ${path}`);
    });
    const html = renderToStaticMarkup(
      await PrDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    );
    expect(html).toContain("Impact lineage unavailable");
    expect(html).toContain("That is not a no-impact result");
    expect(html).not.toContain("This consumer was analyzed and no affected symbols were recorded");
  });

  it("still pauses review when the review history fetch fails", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs/pr-1") return PR;
      if (path === "/prs/pr-1/reviews") throw new Error("reviews down");
      if (path === "/changes/chg1") return { findings: [] };
      throw new Error(`unexpected ${path}`);
    });
    const html = renderToStaticMarkup(
      await PrDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    );
    expect(html).toContain("Review history is temporarily unavailable");
  });
});
