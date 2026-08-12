import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The console views navigate with next/link + next/navigation; stub both so the
// presentational output can be rendered to static markup in a node environment.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
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
import { AlertDialog } from "./alert-dialog";
import { AppShell } from "../ds/index";
import { PULL_REQUESTS, findPullRequest } from "./fixtures";
import {
  toastStore,
  Toaster,
  pushToast,
} from "./toast";
import {
  OPEN_ALL_TOAST,
  confirmOpenAllPrs,
  approveAndMerge,
} from "./interactions";

function countGlow(markup: string): number {
  return markup.match(/indigo-glow/g)?.length ?? 0;
}

describe("DS3 console views — indigo CTA discipline", () => {
  it("keeps at most one indigo-glow CTA per view, and exactly one on the primary-action views", () => {
    const changes = renderToStaticMarkup(<ChangesView />);
    const prs = renderToStaticMarkup(<PrsView prs={PULL_REQUESTS} />);
    const detail = renderToStaticMarkup(
      <PrDetailView pr={findPullRequest("4821")!} />,
    );
    const settings = renderToStaticMarkup(<SettingsView />);

    // Views without their own primary action defer the single screen CTA to the
    // shell topbar ("Open all PRs"); they author no indigo of their own.
    expect(countGlow(changes)).toBe(0);
    expect(countGlow(prs)).toBe(0);

    // The two views that own a primary action render exactly one indigo CTA.
    expect(countGlow(detail)).toBe(1);
    expect(countGlow(settings)).toBe(1);

    // No view ever double-fills indigo.
    for (const markup of [changes, prs, detail, settings]) {
      expect(countGlow(markup)).toBeLessThanOrEqual(1);
    }
  });

  it("gives the shell frame exactly one indigo-glow CTA", () => {
    const shell = renderToStaticMarkup(
      <AppShell view="changes" onNavigate={() => {}}>
        <div />
      </AppShell>,
    );
    expect(countGlow(shell)).toBe(1);
  });
});

describe("DS3 console views — content fidelity", () => {
  it("renders the Warden overview: eyebrow, version, stats, and severities", () => {
    const html = renderToStaticMarkup(<ChangesView />);
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

  it("renders the PR review with an amber alert and the merge CTA", () => {
    const html = renderToStaticMarkup(
      <PrDetailView pr={findPullRequest("4821")!} />,
    );
    expect(html).toContain("Breaking change · POST /v1/charges");
    expect(html).toContain("Approve &amp; merge");
    expect(html).toContain("Open on GitHub");
    expect(html).toContain("ds-alert");
  });

  it("renders the settings form with both cards and Save/Cancel", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("SPEC SOURCE");
    expect(html).toContain("PULL REQUESTS");
    expect(html).toContain("Open PRs as drafts");
    expect(html).toContain("Save changes");
    expect(html).toContain("Cancel");
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

  it("renders whatever the toast store is showing", () => {
    pushToast({ title: "42 pull requests opened", description: "across 42 repositories" });
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain("42 pull requests opened");
    expect(html).toContain("across 42 repositories");
  });
});
