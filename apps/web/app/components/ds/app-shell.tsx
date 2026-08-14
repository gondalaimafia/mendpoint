"use client";

import React from "react";
import { Logo } from "./logo.js";
import { SectionLabel } from "./section-label.js";
import { StatusPill } from "./status-pill.js";
import {
  BellIcon,
  ChevronsUpDownIcon,
  FileJsonIcon,
  GitPullRequestIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  type IconProps,
} from "./icons.js";

type NavItem = {
  id: string;
  label: string;
  icon: (props: IconProps) => React.JSX.Element;
  meta?: number | string;
};
type NavGroup = {
  title: string;
  tone: "warden" | "muted";
  items: NavItem[];
};

const NAV: NavGroup[] = [
  {
    title: "Gauge",
    tone: "warden",
    items: [
      { id: "changes", label: "Breaking changes", icon: ShieldAlertIcon, meta: 6 },
      { id: "specs", label: "API specs", icon: FileJsonIcon, meta: 3 },
    ],
  },
  {
    title: "Regauge",
    tone: "muted",
    items: [
      { id: "prs", label: "Pull requests", icon: GitPullRequestIcon, meta: 42 },
      { id: "runs", label: "Runs", icon: PlayIcon, meta: "live" },
    ],
  },
  {
    title: "Workspace",
    tone: "muted",
    items: [{ id: "settings", label: "Settings", icon: SettingsIcon }],
  },
];

/**
 * The console frame: a 244px rail on `--sidebar`, a 64px topbar matching the
 * marketing site's fixed navbar height, and the page body. A self-contained
 * DS-styled frame the DS3 views mount into — it coexists with the existing
 * `nav.tsx`/layout and does not replace them.
 */
export function AppShell({
  view,
  onNavigate,
  onPrimary,
  primaryLabel,
  primaryIcon,
  children,
}: {
  view: string;
  onNavigate: (id: string) => void;
  onPrimary?: () => void;
  primaryLabel?: string;
  primaryIcon?: (props: IconProps) => React.JSX.Element;
  children: React.ReactNode;
}) {
  const PrimaryIcon = primaryIcon;
  return (
    <div className="ds-shell">
      <aside className="ds-shell__rail">
        <div className="ds-shell__brand">
          <Logo size={22} />
        </div>
        <nav className="ds-shell__nav" aria-label="Console navigation">
          {NAV.map((group) => (
            <div className="ds-shell__group" key={group.title}>
              <SectionLabel tone={group.tone} className="ds-shell__heading">
                {group.title}
              </SectionLabel>
              {group.items.map((item) => {
                const active = view === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    className={`ds-shell__item ${active ? "ds-shell__item--active" : ""}`.trim()}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="ds-shell__item-icon">
                      <Icon size={15} />
                    </span>
                    <span className="ds-shell__item-label">{item.label}</span>
                    {item.meta != null && (
                      <span className="ds-shell__item-meta">{item.meta}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="ds-shell__foot">
          <span className="ds-shell__avatar" aria-hidden>
            TS
          </span>
          <span className="ds-shell__user">Talal S.</span>
          <ChevronsUpDownIcon
            size={14}
            className="ds-shell__foot-caret"
          />
        </div>
      </aside>

      <main id="main" className="ds-shell__main">
        <header className="ds-shell__topbar">
          <div className="ds-shell__search">
            <span className="ds-shell__search-icon">
              <SearchIcon size={15} />
            </span>
            <input
              className="ds-shell__search-input"
              placeholder="acme/payments-sdk"
              aria-label="Search repositories"
            />
          </div>
          <div className="ds-shell__topbar-actions">
            <StatusPill status="pending" label="Scanning 42 repos" pulse />
            <button
              type="button"
              className="ds-btn ds-btn--outline ds-btn--icon"
              aria-label="Notifications"
            >
              <BellIcon size={16} />
            </button>
            {primaryLabel && (
              <button
                type="button"
                className="ds-btn ds-btn--primary indigo-glow"
                onClick={onPrimary}
              >
                {PrimaryIcon && <PrimaryIcon size={15} />}
                {primaryLabel}
              </button>
            )}
          </div>
        </header>
        <div className="ds-shell__body">{children}</div>
      </main>
    </div>
  );
}
