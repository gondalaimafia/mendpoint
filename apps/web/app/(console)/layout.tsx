import type { ReactNode } from "react";
import { ConsoleShell } from "../components/console/console-shell";

/**
 * Shared frame for the DS console routes (/changes, /prs, /prs/[id], /settings).
 * Mounting the `ConsoleShell` here means the DS `AppShell` is created ONCE for
 * the whole group — the pages render only their view. The legacy `nav.tsx`
 * chrome is suppressed for these paths in `AppChrome`, so a console route shows
 * exactly one shell (this one), never the legacy sidebar nested with it.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
