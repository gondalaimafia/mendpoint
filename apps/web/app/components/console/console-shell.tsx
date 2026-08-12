"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../ds/index.js";
import { AlertDialog } from "./alert-dialog.js";
import { Toaster } from "./toast.js";
import { confirmOpenAllPrs } from "./interactions.js";

const ROUTE_BY_NAV: Record<string, string> = {
  changes: "/changes",
  specs: "/changes",
  prs: "/prs",
  runs: "/prs",
  settings: "/settings",
};

/**
 * The one client frame every DS3 route mounts into. It supplies the DS2
 * `AppShell` with router-backed navigation, owns the "Open all PRs" alert dialog
 * the topbar CTA triggers, and mounts the toast surface. Views stay
 * presentational; all of the console's client interactivity lives here.
 */
export function ConsoleShell({
  view,
  children,
}: {
  view: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <>
      <AppShell
        view={view}
        onNavigate={(id) => {
          const href = ROUTE_BY_NAV[id];
          if (href) router.push(href);
        }}
        onPrimary={() => setDialogOpen(true)}
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
