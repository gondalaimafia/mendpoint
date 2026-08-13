"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Nav } from "./nav";

/**
 * Chooses the shell for a route. Console routes (/changes, /prs, /settings and
 * their children) render inside the DS `AppShell` supplied by
 * `app/(console)/layout.tsx`; they must NOT also get the legacy sidebar chrome,
 * so here they render bare. Every other route keeps the legacy `.app-shell`
 * grid with `<Nav/>` exactly as before — unchanged.
 */
const CONSOLE_PREFIXES = ["/changes", "/prs", "/settings"] as const;

function isConsolePath(pathname: string): boolean {
  return CONSOLE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";

  if (isConsolePath(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="app-shell">
      <Nav />
      <main id="main" className="app-content">
        {children}
      </main>
    </div>
  );
}
