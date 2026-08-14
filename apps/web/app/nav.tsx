"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./brand-mark";

const GROUPS = [
  {
    label: "Workspace",
    links: [
      { href: "/console", label: "Overview", glyph: "O" },
      { href: "/provider", label: "API changes", glyph: "C" },
      { href: "/consumer", label: "Repositories", glyph: "R" },
      { href: "/graph", label: "Impact graph", glyph: "G" },
    ],
  },
  {
    label: "Automation",
    links: [
      { href: "/agent", label: "Fettler runs", glyph: "F" },
      { href: "/repair", label: "Verified repair", glyph: "V" },
      { href: "/transformer", label: "Regauge", glyph: "R" },
      { href: "/feeds", label: "Change feeds", glyph: "F" },
    ],
  },
  {
    label: "Operations",
    links: [
      { href: "/status", label: "System status", glyph: "S" },
      { href: "/diagnostics", label: "Diagnostics", glyph: "D" },
      { href: "/applications", label: "Applications", glyph: "A" },
      { href: "/metrics", label: "Metrics", glyph: "M" },
      { href: "/platform", label: "Platform", glyph: "P" },
    ],
  },
  {
    label: "Setup",
    links: [
      { href: "/install", label: "Connect GitHub", glyph: "I" },
      { href: "/brands", label: "Brand packs", glyph: "B" },
      { href: "/billing", label: "Billing", glyph: "$" },
      { href: "/trust", label: "Trust model", glyph: "T" },
    ],
  },
] as const;

export function Nav() {
  const pathname = usePathname() ?? "/";

  const publicPaths = [
    "/",
    "/design-partners",
    "/docs",
    "/privacy",
    "/security",
    "/service-status",
    "/terms",
  ];
  if (publicPaths.includes(pathname) || pathname.startsWith("/docs/")) {
    return (
      <header className="public-nav">
        <Link href="/" className="brand" aria-label="Mendpoint home" prefetch={false}>
          <BrandMark />
          Mendpoint
        </Link>
        <nav aria-label="Public navigation">
          <Link href="/docs">Documentation</Link>
          <Link href="/security">Security</Link>
          <Link href="/design-partners">Apply</Link>
          <Link className="btn" href="/access">Product login</Link>
        </nav>
      </header>
    );
  }

  if (pathname === "/access") {
    return (
      <header className="access-header">
        <Link href="/console" className="brand" aria-label="Mendpoint workspace" prefetch={false}>
          <BrandMark />
          Mendpoint
        </Link>
        <span className="muted small">Design partner access</span>
      </header>
    );
  }

  return (
    <aside className="app-sidebar">
      <div className="sidebar-head">
        <Link href="/console" className="brand" aria-label="Mendpoint workspace" prefetch={false}>
          <BrandMark />
          Mendpoint
        </Link>
        <p>API change operations</p>
      </div>
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {GROUPS.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            <div className="nav-group-links">
              {group.links.map((link) => {
                const active =
                  pathname === link.href ||
                  pathname.startsWith(`${link.href}/`);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    prefetch={false}
                    className={active ? "active" : undefined}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="nav-glyph" aria-hidden>{link.glyph}</span>
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="status-dot ok-dot" aria-hidden />
        <span>Design partner pilot</span>
        <span className="sidebar-foot-note">Review required</span>
      </div>
    </aside>
  );
}
