import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The console views + shell use next/navigation; stub it. `nav.pathname` is
// mutable so each test can render the shell for a specific console route.
const nav = vi.hoisted(() => ({ pathname: "/prs" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => nav.pathname,
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

import { ChangesView } from "./changes-view";
import { PrsView } from "./prs-view";
import { PrDetailView } from "./pr-detail-view";
import { SettingsView } from "./settings-view";
import { ConsoleShell } from "./console-shell";
import { AlertDialog } from "./alert-dialog";
import { AppShell, GitPullRequestIcon } from "../ds/index";
import {
  PULL_REQUESTS,
  SAMPLE_CHANGES_DATA,
  SAMPLE_PR_DETAIL,
  SAMPLE_SETTINGS,
} from "./fixtures";
import { toastStore, Toaster, pushToast } from "./toast";
import {
  OPEN_ALL_TOAST,
  ANALYZE_TOAST,
  confirmOpenAllPrs,
  approveAndMerge,
  analyzeChange,
} from "./interactions";

function countGlow(markup: string): number {
  return markup.match(/indigo-glow/g)?.length ?? 0;
}

/** Render a full console screen (contextual shell CTA + view) for a route. */
function renderScreen(pathname: string, view: React.ReactElement): string {
  nav.pathname = pathname;
  return renderToStaticMarkup(<ConsoleShell>{view}</ConsoleShell>);
}

describe("DS4 console — one indigo CTA per screen", () => {
  it("gives the view bodies no indigo of their own", () => {
    // Every console primary action now lives in the shell topbar, so no view
    // authors an indigo button — not even the detail/settings screens.
    expect(countGlow(renderToStaticMarkup(<ChangesView data={SAMPLE_CHANGES_DATA} />))).toBe(0);
    expect(countGlow(renderToStaticMarkup(<PrsView prs={PULL_REQUESTS} />))).toBe(0);
    expect(
      countGlow(renderToStaticMarkup(<PrDetailView pr={SAMPLE_PR_DETAIL} />)),
    ).toBe(0);
    expect(countGlow(renderToStaticMarkup(<SettingsView data={SAMPLE_SETTINGS} />))).toBe(0);
  });

  it("renders exactly one indigo-glow per console screen (shell + view combined)", () => {
    expect(countGlow(renderScreen("/changes", <ChangesView data={SAMPLE_CHANGES_DATA} />))).toBe(1);
    expect(countGlow(renderScreen("/prs", <PrsView prs={PULL_REQUESTS} />))).toBe(1);
    expect(
      countGlow(renderScreen("/prs/4821", <PrDetailView pr={SAMPLE_PR_DETAIL} />)),
    ).toBe(1);
    expect(countGlow(renderScreen("/settings", <SettingsView data={SAMPLE_SETTINGS} />))).toBe(1);
  });

  it("labels the topbar CTA for the route's primary action", () => {
    expect(renderScreen("/changes", <div />)).toContain("Analyze a change");
    expect(renderScreen("/prs", <div />)).toContain("Open all PRs");
    expect(renderScreen("/prs/4821", <div />)).toContain("Approve &amp; merge");
    expect(renderScreen("/settings", <div />)).toContain("Save");
  });

  it("renders the shell CTA only when a primary action is supplied", () => {
    const withCta = renderToStaticMarkup(
      <AppShell
        view="prs"
        onNavigate={() => {}}
        primaryLabel="Open all PRs"
        primaryIcon={GitPullRequestIcon}
        onPrimary={() => {}}
      >
        <div />
      </AppShell>,
    );
    const withoutCta = renderToStaticMarkup(
      <AppShell view="changes" onNavigate={() => {}}>
        <div />
      </AppShell>,
    );
    expect(countGlow(withCta)).toBe(1);
    expect(countGlow(withoutCta)).toBe(0);
  });
});

describe("DS3 console views — content fidelity", () => {
  it("renders the Warden overview: eyebrow, version, stats, and severities", () => {
    const html = renderToStaticMarkup(<ChangesView data={SAMPLE_CHANGES_DATA} />);
    expect(html).toContain("WARDEN");
    expect(html).toContain("payments-api");
    expect(html).toContain("v2.9.4");
    expect(html).toContain("POST /v1/charges");
    expect(html).toContain("BREAKING");
    // Amber is confined to the breaking-changes stat, never a non-breaking row.
    expect(html).toContain("ds-stat__figure--amber");
  });

  it("renders the four PR tabs with their counts", () => {
    const html = renderToStaticMarkup(<PrsView prs={PULL_REQUESTS} />);
    for (const label of ["All", "Needs review", "Failing", "Merged"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("TRANSFORMER");
  });

  it("renders the PR review with an amber alert and Open on GitHub; the merge CTA is the shell topbar", () => {
    const view = renderToStaticMarkup(<PrDetailView pr={SAMPLE_PR_DETAIL} />);
    expect(view).toContain("Breaking change · POST /v1/charges");
    expect(view).toContain("Open on GitHub");
    expect(view).toContain("ds-alert");
    // The indigo primary action moved out of the view body into the shell.
    expect(countGlow(view)).toBe(0);
    const screen = renderScreen("/prs/4821", <PrDetailView pr={SAMPLE_PR_DETAIL} />);
    expect(screen).toContain("Approve &amp; merge");
  });

  it("renders the settings form with both cards and a ghost Cancel; Save is the shell CTA", () => {
    const view = renderToStaticMarkup(<SettingsView data={SAMPLE_SETTINGS} />);
    expect(view).toContain("SPEC SOURCE");
    expect(view).toContain("PULL REQUESTS");
    expect(view).toContain("Open PRs as drafts");
    expect(view).toContain("Cancel");
    expect(countGlow(view)).toBe(0);
    const screen = renderScreen("/settings", <SettingsView data={SAMPLE_SETTINGS} />);
    expect(screen).toContain("Save");
  });
});

describe("DS console views — honest empty states", () => {
  it("renders a Warden empty state when no change is available", () => {
    const html = renderToStaticMarkup(<ChangesView data={null} />);
    expect(html).toContain("WARDEN");
    expect(html).toContain("No structural change is staged yet");
    expect(countGlow(html)).toBe(0);
  });

  it("renders an empty PR list when the feed has no pull requests", () => {
    const html = renderToStaticMarkup(<PrsView prs={[]} />);
    expect(html).toContain("No pull requests staged yet.");
    // All four tabs still render, each counting zero.
    for (const label of ["All", "Needs review", "Failing", "Merged"]) {
      expect(html).toContain(label);
    }
  });

  it("derives PR tab counts from the injected list, not a constant", () => {
    const html = renderToStaticMarkup(<PrsView prs={PULL_REQUESTS} />);
    const counts = [...html.matchAll(/ds-tab__count">(\d+)</g)].map((m) => m[1]);
    // 5 total, 3 needs-review (open+draft), 1 failing, 1 merged.
    expect(counts).toEqual(["5", "3", "1", "1"]);
  });
});

describe("DS3 interactions — AlertDialog + toast", () => {
  beforeEach(() => toastStore.clear());

  it("presents the open-all alert dialog copy and a focusable confirm", () => {
    const html = renderToStaticMarkup(
      <AlertDialog
        open
        onClose={() => {}}
        title="Open 42 pull requests?"
        description="Each PR targets the default branch and opens as a draft. Transformer runs the test suite before anything is pushed."
        confirmLabel="Open PRs"
        onConfirm={confirmOpenAllPrs}
      />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Open 42 pull requests?");
    expect(html).toContain("opens as a draft");
    expect(html).toContain("Open PRs");
    expect(html).toContain("Cancel");
  });

  it("fires the open-all toast when the dialog confirm handler runs", () => {
    confirmOpenAllPrs();
    const toasts = toastStore.getSnapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("42 pull requests opened");
    expect(toasts[0]!.description).toBe("across 42 repositories");
    expect(OPEN_ALL_TOAST.title).toBe("42 pull requests opened");
  });

  it("fires the merge toast for the approved PR number", () => {
    approveAndMerge(4821);
    const toasts = toastStore.getSnapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("PR #4821 merged");
  });

  it("fires the analyze toast from the changes primary action", () => {
    analyzeChange();
    const toasts = toastStore.getSnapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("Analysis started");
    expect(ANALYZE_TOAST.title).toBe("Analysis started");
  });

  it("renders whatever the toast store is showing", () => {
    pushToast({ title: "42 pull requests opened", description: "across 42 repositories" });
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain("42 pull requests opened");
    expect(html).toContain("across 42 repositories");
  });
});
