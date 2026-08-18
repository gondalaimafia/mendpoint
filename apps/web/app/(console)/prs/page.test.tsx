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
vi.mock("../../../lib/api", () => ({ apiGet }));

import PullRequestsPage from "./page";

describe("/prs page — a rejected /prs fetch renders unavailable, not empty", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("passes unavailable=true so the view does not certify a failure as 'none staged'", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs") throw new Error("API /prs returned 500");
      if (path === "/consumers") return [];
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await PullRequestsPage());

    expect(html).toContain("Pull requests unavailable");
    expect(html).not.toContain("No pull requests staged yet.");
  });

  it("renders the honest empty state when the feed loads with no PRs", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs") return [];
      if (path === "/consumers") return [];
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await PullRequestsPage());

    expect(html).toContain("No pull requests staged yet.");
    expect(html).not.toContain("Pull requests unavailable");
  });
});
