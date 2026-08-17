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
import { ReviewDialog } from "./review-dialog";
import { AppShell, GitPullRequestIcon } from "../ds/index";
import {
  PULL_REQUESTS,
  SAMPLE_CHANGES_DATA,
  SAMPLE_PR_DETAIL,
  SAMPLE_SETTINGS,
} from "./fixtures";
import { toastStore, Toaster, pushToast } from "./toast";
import {
  REVIEW_DECISION_META,
  pushReviewSuccessToast,
  reviewErrorMessage,
  submitPrReview,
} from "./interactions";
import { reviewDialogStore, openReviewDialog } from "./review-dialog-store";

function countGlow(markup: string): number {
  return markup.match(/indigo-glow/g)?.length ?? 0;
}

/** Render a full console screen (contextual shell CTA + view) for a route. */
function renderScreen(pathname: string, view: React.ReactElement): string {
  nav.pathname = pathname;
  return renderToStaticMarkup(<ConsoleShell>{view}</ConsoleShell>);
}

describe("DS4 console — the one real CTA is the PR approve action", () => {
  it("gives the view bodies no indigo of their own", () => {
    // The only console primary action is the PR review "Approve" in the shell
    // topbar, so no view authors an indigo button. The detail view's secondary
    // review controls are outline buttons, not indigo.
    expect(countGlow(renderToStaticMarkup(<ChangesView data={SAMPLE_CHANGES_DATA} />))).toBe(0);
    expect(countGlow(renderToStaticMarkup(<PrsView prs={PULL_REQUESTS} />))).toBe(0);
    expect(
      countGlow(renderToStaticMarkup(<PrDetailView pr={SAMPLE_PR_DETAIL} />)),
    ).toBe(0);
    expect(countGlow(renderToStaticMarkup(<SettingsView data={SAMPLE_SETTINGS} />))).toBe(0);
  });

  it("shows the single indigo CTA only on the PR review screen", () => {
    // The removed fake CTAs (Analyze a change / Open all PRs / Save) left their
    // screens with no fabricated primary; only the PR review screen keeps one.
    expect(countGlow(renderScreen("/changes", <ChangesView data={SAMPLE_CHANGES_DATA} />))).toBe(0);
    expect(countGlow(renderScreen("/prs", <PrsView prs={PULL_REQUESTS} />))).toBe(0);
    expect(
      countGlow(renderScreen("/prs/4821", <PrDetailView pr={SAMPLE_PR_DETAIL} />)),
    ).toBe(1);
    expect(countGlow(renderScreen("/settings", <SettingsView data={SAMPLE_SETTINGS} />))).toBe(0);
  });

  it("labels the PR review CTA 'Approve' and carries no fabricated CTAs elsewhere", () => {
    const detail = renderScreen("/prs/4821", <div />);
    expect(detail).toContain("Approve");
    // The old lie: a control that claimed a merge. It must be gone.
    expect(detail).not.toContain("Approve &amp; merge");
    // The three removed fake CTAs no longer render on any screen.
    expect(renderScreen("/changes", <div />)).not.toContain("Analyze a change");
    expect(renderScreen("/prs", <div />)).not.toContain("Open all PRs");
    expect(renderScreen("/settings", <div />)).not.toContain(">Save<");
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
    expect(html).toContain("FETTLER");
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
    expect(html).toContain("REGAUGE");
  });

  it("renders the PR review with an amber alert, Open on GitHub, and secondary review controls; the Approve CTA is the shell topbar", () => {
    const view = renderToStaticMarkup(<PrDetailView pr={SAMPLE_PR_DETAIL} />);
    expect(view).toContain("Breaking change · POST /v1/charges");
    expect(view).toContain("Open on GitHub");
    expect(view).toContain("ds-alert");
    // Secondary review decisions live in the view body as outline buttons.
    expect(view).toContain("Request changes");
    expect(view).toContain("Reject");
    // The indigo primary action lives in the shell, not the view body.
    expect(countGlow(view)).toBe(0);
    const screen = renderScreen("/prs/4821", <PrDetailView pr={SAMPLE_PR_DETAIL} />);
    expect(screen).toContain("Approve");
    expect(screen).not.toContain("Approve &amp; merge");
  });

  it("renders the settings form with both cards and a ghost Cancel; there is no fabricated Save action", () => {
    const view = renderToStaticMarkup(<SettingsView data={SAMPLE_SETTINGS} />);
    expect(view).toContain("SPEC SOURCE");
    expect(view).toContain("PULL REQUESTS");
    expect(view).toContain("Open PRs as drafts");
    expect(view).toContain("Cancel");
    expect(countGlow(view)).toBe(0);
    // No settings-persistence endpoint exists, so no "Save" control is shown.
    const screen = renderScreen("/settings", <SettingsView data={SAMPLE_SETTINGS} />);
    expect(screen).not.toContain(">Save<");
  });
});

describe("DS console views — honest empty states", () => {
  it("does not certify a null (failed/absent) change feed as clean", () => {
    // data === null means the fetch failed OR nothing is staged; the view must
    // not claim "No breaking changes", which would present a fetch failure as a
    // clean result (the §11.7 silent-zero bug in the UI).
    const html = renderToStaticMarkup(<ChangesView data={null} />);
    expect(html).toContain("FETTLER");
    expect(html).toContain("Changes unavailable");
    expect(html).not.toContain("No breaking changes");
    expect(html).toContain("not a claim that the spec is unchanged");
    expect(countGlow(html)).toBe(0);
  });

  it("renders an analyzed-but-empty diff without conflating it with a load failure", () => {
    const html = renderToStaticMarkup(
      <ChangesView data={{ target: "acme · v1 → v2", stats: [], changes: [] }} />,
    );
    expect(html).toContain("acme · v1 → v2");
    expect(html).toContain("No structural change is staged yet");
    expect(html).not.toContain("Changes unavailable");
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

describe("console review actions — real decisions, no fabricated results", () => {
  beforeEach(() => {
    toastStore.clear();
    reviewDialogStore.close();
    vi.unstubAllGlobals();
  });

  it("posts a real review decision to the same-origin API proxy", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "review-1", decision: "approve" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await submitPrReview("pr-4821", "approve", "Diff looks correct");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/prs/pr-4821/reviews");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      decision: "approve",
      rationale: "Diff looks correct",
    });
  });

  it("surfaces the API error code as a reviewer-facing message on failure", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: "review_rationale_invalid" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPrReview("pr-1", "approve", "no")).rejects.toThrow(
      "Add a rationale of at least 3 characters before recording a decision.",
    );
    // A failed submission never fires a success toast.
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });

  it("maps unknown error codes to a safe generic message", () => {
    expect(reviewErrorMessage("human_review_identity_required")).toBe(
      "Only a signed-in human reviewer can record a decision.",
    );
    expect(reviewErrorMessage("some_new_code")).toBe(
      "Could not record the review. Try again.",
    );
  });

  it("fires an honest 'recorded' toast — never a merge claim", () => {
    pushReviewSuccessToast("approve");
    const toasts = toastStore.getSnapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("Approval recorded");
    expect(toasts[0]!.title).not.toContain("merged");
    expect(toasts[0]!.description).toContain("Merging stays a human action");
    // Every exposed decision records rather than merges.
    expect(REVIEW_DECISION_META.reject.success.title).toBe("Rejection recorded");
    expect(REVIEW_DECISION_META.request_changes.success.title).toBe("Changes requested");
  });

  it("opens the shared review dialog with a required rationale field", () => {
    openReviewDialog("pr-4821", "approve");
    expect(reviewDialogStore.getSnapshot()).toEqual({
      prId: "pr-4821",
      decision: "approve",
    });
    const html = renderToStaticMarkup(<ReviewDialog />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Approve this pull request?");
    expect(html).toContain("Rationale");
    expect(html).toContain("Record approval");
    expect(html).toContain("Merging stays a human action in GitHub.");
  });

  it("renders nothing when no review dialog is open", () => {
    reviewDialogStore.close();
    expect(renderToStaticMarkup(<ReviewDialog />)).toBe("");
  });

  it("renders whatever the toast store is showing", () => {
    pushToast({ title: "Approval recorded", description: "Your approval is on the record." });
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain("Approval recorded");
    expect(html).toContain("Your approval is on the record.");
  });
});
