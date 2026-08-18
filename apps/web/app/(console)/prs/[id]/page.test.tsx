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

describe("/prs/[id] page — coverage keeps a clean result distinct from an unanalyzed one", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  async function renderWith(prOverrides: Record<string, unknown>): Promise<string> {
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/prs/pr-1") return { ...PR, ...prOverrides };
      if (path === "/consumers") {
        return [{ id: "con1", name: "acme", githubOwner: "acme", githubRepo: "payments-sdk" }];
      }
      if (path === "/changes/chg1") {
        return { id: "chg1", risk: "safe", summary: "", diff: { entries: [], risk: "safe", summary: "" } };
      }
      throw new Error(`unexpected ${path}`);
    });
    return renderToStaticMarkup(
      await PullRequestDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    );
  }

  it("renders an analyzed + zero-findings PR as a positive result, never as failing", async () => {
    const html = await renderWith({
      status: "low_confidence",
      risk: "safe",
      coverage: { basis: "analyzed", gaps: [], filesInspected: 42, filesInScope: 42 },
    });
    // A verified-clean result is positive, not a red failure.
    expect(html).not.toContain("ds-status--failing");
    expect(html).toContain("ds-status--open");
    expect(html).toContain("No impact — verified");
    expect(html).toContain("complete evidence of no impact");
    expect(html).toContain("42 of 42 files inspected");
    // And it must not read like an unanalyzed result.
    expect(html).not.toContain("not a clean result");
  });

  it("renders a not_analyzed PR as no-basis, never as clean", async () => {
    const html = await renderWith({
      status: "low_confidence",
      risk: "safe",
      coverage: { basis: "not_analyzed", reason: "No supported language present.", gaps: [] },
    });
    expect(html).toContain("Not analyzed");
    expect(html).toContain("not a clean result");
    // Must not borrow the clean result's evidence-of-safety language.
    expect(html).not.toContain("complete evidence of no impact");
    // Genuinely weak -> amber pending, not a fabricated red.
    expect(html).toContain("ds-status--pending");
    expect(html).not.toContain("ds-status--failing");
  });

  it("surfaces the typed gap reasons of a partial-coverage PR", async () => {
    const html = await renderWith({
      status: "low_confidence",
      risk: "safe",
      coverage: {
        basis: "partial",
        reason: "Some files were not analyzed.",
        gaps: [
          { reason: "unsupported_language", detail: "3 .rb files were not analyzed", count: 3 },
          { reason: "file_cap", detail: "cap of 5000 files reached", count: 5000 },
        ],
      },
    });
    expect(html).toContain("partial coverage");
    expect(html).toContain("Unsupported language");
    expect(html).toContain("3 .rb files were not analyzed");
    expect(html).toContain("File-count cap reached");
    expect(html).toContain("ds-status--pending");
    expect(html).not.toContain("ds-status--failing");
  });

  it("renders a PR with no coverage field as unknown, and does not crash", async () => {
    const html = await renderWith({ status: "low_confidence", risk: "safe" });
    expect(html).toContain("Coverage not recorded");
    expect(html).toContain("unverified");
    expect(html).not.toContain("complete evidence of no impact");
    // Absent coverage is unknown, never clean or failing.
    expect(html).toContain("ds-status--pending");
    expect(html).not.toContain("ds-status--failing");
  });
});
