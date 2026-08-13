"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  AppShell,
  CheckIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ShieldAlertIcon,
  type IconProps,
} from "../ds/index.js";
import { AlertDialog } from "./alert-dialog.js";
import { Toaster } from "./toast.js";
import {
  analyzeChange,
  approveAndMerge,
  confirmOpenAllPrs,
  saveSettings,
} from "./interactions.js";

const ROUTE_BY_NAV: Record<string, string> = {
  changes: "/changes",
  specs: "/changes",
  prs: "/prs",
  runs: "/runs",
  settings: "/settings",
};

/** The rail's active nav id for a given console path. */
function navViewFor(pathname: string): string {
  if (pathname.startsWith("/changes")) return "changes";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/runs")) return "runs";
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
 * navigation, owns the "Open all PRs" alert dialog, and mounts the toast
 * surface. The topbar CTA is CONTEXTUAL — derived from the current path so each
 * screen shows exactly one indigo primary action (and the view bodies author
 * none). Views stay presentational; all console client interactivity lives here.
 */
export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const view = navViewFor(pathname);

  const primary = React.useMemo<PrimaryAction | null>(() => {
    const detail = pathname.match(/^\/prs\/([^/]+)/);
    if (detail) {
      const prNumber = Number(detail[1]);
      return {
        label: "Approve & merge",
        icon: GitMergeIcon,
        onPrimary: () => approveAndMerge(prNumber),
      };
    }
    if (pathname.startsWith("/prs")) {
      return {
        label: "Open all PRs",
        icon: GitPullRequestIcon,
        onPrimary: () => setDialogOpen(true),
      };
    }
    if (pathname.startsWith("/settings")) {
      return { label: "Save", icon: CheckIcon, onPrimary: saveSettings };
    }
    if (pathname.startsWith("/changes")) {
      return {
        label: "Analyze a change",
        icon: ShieldAlertIcon,
        onPrimary: analyzeChange,
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

      <AlertDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Open 42 pull requests?"
        description="Each PR targets the default branch and opens as a draft. Transformer runs the test suite before anything is pushed."
        cancelLabel="Cancel"
        confirmLabel="Open PRs"
        onConfirm={confirmOpenAllPrs}
      />

      <Toaster />
    </>
  );
}
