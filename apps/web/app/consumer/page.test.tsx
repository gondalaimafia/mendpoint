import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pendingPrs } = vi.hoisted(() => ({
  pendingPrs: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock("../../lib/api", () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path === "/prs") return pendingPrs.rows;
    return [];
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

const originalFlag = process.env.MENDPOINT_SELF_SERVE_WARDEN;

const BASE_PR = {
  id: "pr1",
  changeId: "chg1",
  consumerId: "c1",
  title: "Migrate charge()",
  body: "",
  branchName: "fettler/pr1",
  status: "low_confidence",
  risk: "low",
  patchUnified: "",
  githubPrNumber: null,
  githubPrUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function renderPage(): Promise<string> {
  // Re-import per-test so the flag read at module/render time reflects env.
  vi.resetModules();
  const { default: ConsumerPage } = await import("./page.js");
  return renderToStaticMarkup(await ConsumerPage());
}

afterEach(() => {
  pendingPrs.rows = [];
  if (originalFlag === undefined) delete process.env.MENDPOINT_SELF_SERVE_WARDEN;
  else process.env.MENDPOINT_SELF_SERVE_WARDEN = originalFlag;
});

describe("consumer console self-serve scan trigger", () => {
  it("keeps the demo placeholder byte-identical when the flag is off", async () => {
    delete process.env.MENDPOINT_SELF_SERVE_WARDEN;
    const html = await renderPage();
    expect(html).toContain("No pending PRs — run <code>npm run demo</code> after seed.");
    expect(html).not.toContain("Scan for impact");
  });

  it("does not enable the trigger for a non-exact flag value", async () => {
    process.env.MENDPOINT_SELF_SERVE_WARDEN = "true";
    const html = await renderPage();
    expect(html).toContain("No pending PRs — run <code>npm run demo</code> after seed.");
    expect(html).not.toContain("Scan for impact");
  });

  it("replaces the placeholder with a Scan for impact trigger when the flag is on", async () => {
    process.env.MENDPOINT_SELF_SERVE_WARDEN = "1";
    const html = await renderPage();
    expect(html).toContain("Scan for impact");
    expect(html).not.toContain("npm run demo");
  });
});

describe("consumer pending PRs — FET-017 coverage standing", () => {
  it("does not treat a missing coverage channel as verified no-impact", async () => {
    pendingPrs.rows = [{ ...BASE_PR }];
    const html = await renderPage();
    expect(html).toContain("coverage unknown");
    expect(html).toContain("low_confidence");
    expect(html).not.toContain("no impact");
    expect(html).toContain("Migrate charge()");
  });

  it("keeps analyzed empty findings distinct from partial coverage", async () => {
    pendingPrs.rows = [
      {
        ...BASE_PR,
        id: "clean",
        title: "Clean analyzed PR",
        coverage: { basis: "analyzed", gaps: [] },
      },
      {
        ...BASE_PR,
        id: "partial",
        title: "Partial PR",
        coverage: {
          basis: "partial",
          reason: "Ruby files were present but unsupported.",
          gaps: [],
        },
      },
    ];
    const html = await renderPage();
    expect(html).toContain("no impact");
    expect(html).toContain("partial coverage");
    expect(html).toContain("Clean analyzed PR");
    expect(html).toContain("Partial PR");
  });
});
