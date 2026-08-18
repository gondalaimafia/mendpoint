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
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => "/prs",
}));

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../../../../lib/api", () => ({ apiGet }));

import PullRequestDetailPage from "./page";

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

describe("/prs/[id] page — an unloadable PR has unknown status, not a false 'failing'", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("renders an unavailable placeholder with a pending (unknown) status when the PR fetch throws", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs/pr-1") throw new Error("API /prs/pr-1 returned 500");
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(
      await PullRequestDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    );

    expect(html).toContain("Pull request unavailable");
    // Unknown status, not a fabricated red "failing" pill.
    expect(html).toContain("ds-status--pending");
    expect(html).not.toContain("ds-status--failing");
  });

  it("renders the real PR (not the placeholder) when the fetch resolves", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs/pr-1") return PR;
      if (path === "/consumers") {
        return [{ id: "con1", name: "acme", githubOwner: "acme", githubRepo: "payments-sdk" }];
      }
      if (path === "/changes/chg1") {
        return { id: "chg1", risk: "safe", summary: "", diff: { entries: [], risk: "safe", summary: "" } };
      }
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(
      await PullRequestDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    );

    expect(html).toContain("Migrate charge()");
    expect(html).not.toContain("Pull request unavailable");
    expect(html).not.toContain("ds-status--pending");
  });
});
