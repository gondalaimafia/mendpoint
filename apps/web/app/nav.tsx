"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/provider", label: "Provider" },
  { href: "/consumer", label: "Consumer" },
  { href: "/graph", label: "Graph" },
  { href: "/repair", label: "Repair" },
  { href: "/agent", label: "Warden" },
  { href: "/feeds", label: "Feeds" },
  { href: "/install", label: "Install" },
  { href: "/brands", label: "Brands" },
  { href: "/billing", label: "Billing" },
  { href: "/metrics", label: "Metrics" },
  { href: "/platform", label: "Platform" },
  { href: "/status", label: "Status" },
  { href: "/trust", label: "Trust" },
] as const;

export function Nav() {
  const pathname = usePathname() ?? "/";

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Mendpoint home">
          Mendpoint
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {LINKS.map((l) => {
            const active =
              pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
