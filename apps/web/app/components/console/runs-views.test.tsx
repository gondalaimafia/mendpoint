import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/runs" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {} }),
  usePathname: () => nav.pathname,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
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

// Real ApiRequestError class so the page's `instanceof` check works against the
// same module the page imports; apiGet is controllable per test.
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../lib/api", () => {
  class ApiRequestError extends Error {
    constructor(
      readonly path: string,
      readonly status: number,
      readonly requestId: string | null,
    ) {
      super(`API ${path} returned ${status}`);
      this.name = "ApiRequestError";
    }
  }
  return { ApiRequestError, apiGet: api.get, apiBase: () => "http://localhost:3001" };
});

import { RunsView } from "./runs-view";
import { RunDetailView } from "./run-detail-view";
import { ConsoleShell } from "./console-shell";
import { SAMPLE_RUNS, SAMPLE_RUN_DETAIL, type RunDetailData } from "./fixtures";
import RunsPage from "../../(console)/runs/page";
import RunDetailPage from "../../(console)/runs/[id]/page";
import { ApiRequestError } from "../../../lib/api";

function countGlow(markup: string): number {
  return markup.match(/indigo-glow/g)?.length ?? 0;
}

describe("runs console — list view", () => {
  it("renders the tenant runs with status, target, timing and trigger", () => {
    const html = renderToStaticMarkup(<RunsView runs={SAMPLE_RUNS} />);
    expect(html).toContain("acme/payments-sdk");
    expect(html).toContain("Fix charge()");
    expect(html).toContain("warden.run");
    expect(html).toContain("failed");
    expect(html).toContain("alpha");
    // Warden run shows the recorded trigger; the scan shows the honest fallback.
    expect(html).toContain("by human:owner-a@example.com");
    expect(html).toContain("by not recorded");
    // The reused start control is present.
    expect(html).toContain("Scan for impact");
  });

  it("derives the four status-tab counts from the injected list", () => {
    const html = renderToStaticMarkup(<RunsView runs={SAMPLE_RUNS} />);
    const counts = [...html.matchAll(/ds-tab__count">(\d+)</g)].map((m) => m[1]);
    // 2 total, 1 active (pending), 1 failed, 0 done.
    expect(counts).toEqual(["2", "1", "1", "0"]);
  });

  it("shows an honest empty state and the start control when there are no runs", () => {
    const html = renderToStaticMarkup(<RunsView runs={[]} />);
    expect(html).toContain("No runs yet. Start a scan to queue your first run.");
    expect(html).toContain("Scan for impact");
  });

  it("authors no indigo of its own", () => {
    expect(countGlow(renderToStaticMarkup(<RunsView runs={SAMPLE_RUNS} />))).toBe(0);
  });
});

describe("runs console — detail view", () => {
  it("renders plan, log, verification, changes, PR and review handoff from real data", () => {
    const html = renderToStaticMarkup(<RunDetailView data={SAMPLE_RUN_DETAIL} />);
    expect(html).toContain("PLAN");
    expect(html).toContain("Locate call sites");
    expect(html).toContain("EXECUTION LOG");
    expect(html).toContain("Trajectory warden-run-a1");
    expect(html).toContain("npm test");
    expect(html).toContain("charges.create"); // DiffView on the real patch
    expect(html).toContain("#4821");
    // Review handoff links to the existing review surface.
    expect(html).toContain('href="/prs/pr-a1"');
    // Controls are neutral, not indigo.
    expect(html).toContain("Pause / cancel");
    expect(html).toContain("Retry");
    expect(countGlow(html)).toBe(0);
  });

  it("shows honest empty states and disabled-control reasons where data is absent", () => {
    const empty: RunDetailData = {
      run: {
        ...SAMPLE_RUNS[1]!,
        canCancel: false,
        cancelReason: "Run already finished",
        canRetry: false,
        retryReason: "Run completed successfully",
      },
      plan: null,
      log: null,
      verification: [],
      changedPaths: [],
      diffs: [],
      prs: [],
      reviewHref: null,
    };
    const html = renderToStaticMarkup(<RunDetailView data={empty} />);
    expect(html).toContain("No plan was recorded for this run type.");
    expect(html).toContain("No execution log was recorded for this run.");
    expect(html).toContain("No file changes are recorded for this run.");
    expect(html).toContain("None opened yet");
    // The reasons the API returned are surfaced.
    expect(html).toContain("Cancel unavailable: Run already finished");
    expect(html).toContain("Retry unavailable: Run completed successfully");
    // "Open review" is disabled when there is no review surface.
    expect(html).toMatch(/Open review<\/button>/);
  });
});

describe("runs console — shell nav", () => {
  it("activates the Runs nav item on a /runs path with no extra indigo CTA", () => {
    nav.pathname = "/runs";
    const html = renderToStaticMarkup(
      <ConsoleShell>
        <RunsView runs={SAMPLE_RUNS} />
      </ConsoleShell>,
    );
    expect(html).toContain('aria-current="page"');
    // The run console owns no shell indigo CTA (start/controls are neutral).
    expect(countGlow(html)).toBe(0);
  });
});

describe("runs console — flag-gated pages", () => {
  it("404s the run list when the API route is absent (flag off)", async () => {
    api.get.mockRejectedValueOnce(new ApiRequestError("/self-serve/runs", 404, null));
    await expect(RunsPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s the run detail when the API route is absent (flag off)", async () => {
    api.get.mockRejectedValueOnce(new ApiRequestError("/self-serve/runs/x", 404, null));
    await expect(
      RunDetailPage({ params: Promise.resolve({ id: "x" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
