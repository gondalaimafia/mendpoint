"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppShell, CheckIcon, type IconProps } from "../ds/index.js";
import { Toaster } from "./toast.js";
import { ReviewDialog } from "./review-dialog.js";
import { openReviewDialog } from "./review-dialog-store.js";

const ROUTE_BY_NAV: Record<string, string> = {
  changes: "/changes",
  specs: "/changes",
  prs: "/prs",
  runs: "/prs",
  settings: "/settings",
};

/** The rail's active nav id for a given console path. */
function navViewFor(pathname: string): string {
  if (pathname.startsWith("/changes")) return "changes";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/prs")) return "prs";
  return "";
}

type PrimaryAction = {
  label: string;
  icon: (props: IconProps) => React.JSX.Element;
  onPrimary: () => void;
};

/**
 * The one client frame every DS console route mounts into (via the shared
 * `app/(console)/layout.tsx`). It supplies the DS2 `AppShell` with router-backed
 * navigation and mounts the toast + review-dialog surfaces. The only topbar CTA
 * is the PR review screen's "Approve" — the single indigo primary action —
 * which opens the shared review dialog to record a real approval (Mendpoint is
 * review-first and never merges). Other screens carry no fabricated CTA.
 */
export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";

  const view = navViewFor(pathname);

  const primary = React.useMemo<PrimaryAction | null>(() => {
    const detail = pathname.match(/^\/prs\/([^/]+)/);
    if (detail) {
      const prId = decodeURIComponent(detail[1]!);
      return {
        label: "Approve",
        icon: CheckIcon,
        onPrimary: () => openReviewDialog(prId, "approve"),
      };
    }
    return null;
  }, [pathname]);

  return (
    <>
      <AppShell
        view={view}
        onNavigate={(id) => {
          const href = ROUTE_BY_NAV[id];
          if (href) router.push(href);
        }}
        primaryLabel={primary?.label}
        primaryIcon={primary?.icon}
        onPrimary={primary?.onPrimary}
      >
        {children}
      </AppShell>

      <ReviewDialog />
      <Toaster />
    </>
  );
}
