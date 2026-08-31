import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Logo } from "./logo.js";
import { SectionLabel } from "./section-label.js";
import { StatusPill } from "./status-pill.js";
import { Badge } from "./badge.js";
import { DiffView } from "./diff-view.js";
import { Terminal } from "./terminal.js";
import { PullRequestCard } from "./pull-request-card.js";
import { AppShell } from "./app-shell.js";
import { GitPullRequestIcon } from "./icons.js";

describe("DS2 signature components", () => {
  it("Logo reuses the approved brand mark and sizes the wordmark at 0.78x", () => {
    const html = renderToStaticMarkup(<Logo size={26} />);
    // Reuses the app's approved arrow mark, not the DS trace mark.
    expect(html).toContain("Mendpoint arrow mark");
    expect(html).toContain("#356cff");
    expect(html).toContain("#00bcc1");
    // Wordmark present at 0.78x of size (26 * 0.78 = 20.28px).
    expect(html).toContain("Mendpoint</span>");
    expect(html).toContain("20.28px");
    // Must not introduce the DS-only emerald mark color.
    expect(html).not.toContain("#34d399");
  });

  it("SectionLabel maps tones onto the DS1 .section-label utility", () => {
    expect(
      renderToStaticMarkup(<SectionLabel tone="warden">Warden</SectionLabel>),
    ).toContain("section-label section-label--warden");
    expect(
      renderToStaticMarkup(<SectionLabel tone="muted">Workspace</SectionLabel>),
    ).toContain("section-label--muted");
  });

  it("StatusPill is the only pill shape and tints by lifecycle state", () => {
    const merged = renderToStaticMarkup(<StatusPill status="merged" />);
    expect(merged).toContain("ds-status ds-status--merged");
    expect(merged).toContain("ds-status__dot");
    const pending = renderToStaticMarkup(
      <StatusPill status="pending" label="Scanning" pulse />,
    );
    expect(pending).toContain("ds-status--pulse");
    expect(pending).toContain("Scanning");
  });

  it("Badge reserves the warn tone for severity", () => {
    expect(renderToStaticMarkup(<Badge tone="warn">breaking</Badge>)).toContain(
      "ds-badge ds-badge--warn",
    );
  });

  it("DiffView carries emerald adds and destructive removes with a gutter", () => {
    const html = renderToStaticMarkup(
      <DiffView
        path="src/api.ts"
        hunks={[
          {
            header: "@@ -1,3 +1,4 @@",
            lines: [
              { type: "ctx", text: "const x = 1", line: 1 },
              { type: "add", text: "const y = 2", line: 2 },
              { type: "del", text: "const z = 3", line: 3 },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("ds-diff__row--add");
    expect(html).toContain("ds-diff__row--del");
    expect(html).toContain("ds-diff__gutter");
    // Auto-counted stats: 1 add, 1 del.
    expect(html).toContain("+1");
  });

  it("Terminal shows the prompt only on command lines", () => {
    const html = renderToStaticMarkup(
      <Terminal
        lines={[
          "warden scan",
          { type: "ok", text: "0 breaking changes" },
        ]}
        caret
      />,
    );
    expect(html).toContain("ds-term__prompt");
    expect(html).toContain("ds-term__prompt--hidden");
    expect(html).toContain("ds-term__ok");
    expect(html).toContain("ds-term__caret");
  });

  it("PullRequestCard renders a status pill, mono meta, and agent tint", () => {
    const html = renderToStaticMarkup(
      <PullRequestCard
        repo="acme/payments-sdk"
        title="Migrate to v3 client"
        number={4821}
        status="open"
        agent="transformer"
        additions={128}
        deletions={64}
        files={7}
        checks="passing"
        time="2h ago"
        onClick={() => {}}
      />,
    );
    expect(html).toContain("ds-pr-card");
    expect(html).toContain("ds-pr-card--interactive");
    expect(html).toContain("ds-pr-card__icon--transformer");
    expect(html).toContain("ds-status--open");
    expect(html).toContain("+128");
    expect(html).toContain("7 files");
  });

  it("AppShell frames a 244px rail and 64px topbar with the contextual primary CTA", () => {
    const html = renderToStaticMarkup(
      <AppShell
        view="prs"
        onNavigate={() => {}}
        onPrimary={() => {}}
        primaryLabel="Open all PRs"
        primaryIcon={GitPullRequestIcon}
      >
        <div>body</div>
      </AppShell>,
    );
    expect(html).toContain("ds-shell");
    expect(html).toContain("ds-shell__topbar");
    // Active rail row reflects the current view.
    expect(html).toContain("ds-shell__item--active");
    // Exactly one indigo-glow primary button in the frame — the CTA supplied.
    expect(html.match(/indigo-glow/g)?.length).toBe(1);
    expect(html).toContain("Open all PRs");
    expect(html).toContain("body");
    const fettler = html.indexOf("Fettler");
    const pullRequests = html.indexOf("Pull requests");
    const regauge = html.indexOf("ReGauge");
    expect(fettler).toBeGreaterThanOrEqual(0);
    expect(pullRequests).toBeGreaterThan(fettler);
    expect(regauge).toBeGreaterThan(pullRequests);
    expect(html).not.toContain("Regauge");
  });

  it("AppShell renders no primary CTA when none is supplied", () => {
    const html = renderToStaticMarkup(
      <AppShell view="changes" onNavigate={() => {}}>
        <div>body</div>
      </AppShell>,
    );
    expect(html).toContain("ds-shell__topbar");
    expect(html.match(/indigo-glow/g)?.length ?? 0).toBe(0);
  });
});
