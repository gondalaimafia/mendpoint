"use client";

import React from "react";
import { CheckIcon, ChevronDownIcon, SectionLabel } from "../ds/index.js";
import type { SettingsData } from "./fixtures.js";

/**
 * `/settings` — workspace settings, capped at 640px, seeded from live config
 * (`SettingsData`) read in the page: spec-source URL + target version from the
 * provider, and the PR-policy toggles from `/policies/defaults`. Two cards: spec
 * source (a mono URL input and a target-version select) and pull requests (a
 * "drafts" checkbox with its consequence line and two switches). Cancel is a
 * ghost button in the footer. Reads are live; there is no settings-persistence
 * endpoint yet, so the console shows no "Save" action rather than a control that
 * claims to save when it does not.
 */
export function SettingsView({ data }: { data: SettingsData }) {
  const [drafts, setDrafts] = React.useState(data.drafts);
  const [autoOpen, setAutoOpen] = React.useState(data.autoOpen);
  const [notifySlack, setNotifySlack] = React.useState(data.notifySlack);

  const versionOptions =
    data.versionOptions.length > 0
      ? data.versionOptions
      : data.targetVersion
        ? [data.targetVersion]
        : [];

  return (
    <div className="ds-view ds-settings">
      <header className="ds-view__header ds-view__header--stack">
        <SectionLabel tone="muted">WORKSPACE</SectionLabel>
        <h1 className="ds-view__title">Settings</h1>
      </header>

      <section className="ds-panel ds-panel--pad ds-settings__card">
        <div className="section-label section-label--muted">SPEC SOURCE</div>
        <div className="ds-form">
          <div className="ds-field">
            <label className="ds-field__label" htmlFor="spec-url">
              OpenAPI spec URL
            </label>
            <input
              id="spec-url"
              className="ds-input ds-input--mono"
              defaultValue={data.specUrl}
              placeholder="No spec source configured"
            />
            <span className="ds-field__hint">Polled on every tagged release.</span>
          </div>
          <div className="ds-field">
            <label className="ds-field__label" htmlFor="target-version">
              Target version
            </label>
            <div className="ds-select-wrap">
              <select
                id="target-version"
                className="ds-select"
                defaultValue={data.targetVersion}
              >
                {versionOptions.length === 0 && (
                  <option value="">No versions published</option>
                )}
                {versionOptions.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <span className="ds-select-wrap__caret" aria-hidden>
                <ChevronDownIcon size={14} />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="ds-panel ds-panel--pad ds-settings__card">
        <div className="section-label section-label--muted">PULL REQUESTS</div>
        <div className="ds-form">
          <button
            type="button"
            role="checkbox"
            aria-checked={drafts}
            className={`ds-check ${drafts ? "ds-check--on" : ""}`.trim()}
            onClick={() => setDrafts((v) => !v)}
          >
            <span className="ds-check__box" aria-hidden>
              {drafts && <CheckIcon size={11} />}
            </span>
            <span className="ds-check__text">
              <span className="ds-check__label">Open PRs as drafts</span>
              <span className="ds-check__hint">
                Nothing lands without a human review.
              </span>
            </span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={autoOpen}
            className={`ds-switch ${autoOpen ? "ds-switch--on" : ""}`.trim()}
            onClick={() => setAutoOpen((v) => !v)}
          >
            <span className="ds-switch__track" aria-hidden>
              <span className="ds-switch__thumb" />
            </span>
            <span className="ds-switch__label">Auto-open PRs on release</span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={notifySlack}
            className={`ds-switch ${notifySlack ? "ds-switch--on" : ""}`.trim()}
            onClick={() => setNotifySlack((v) => !v)}
          >
            <span className="ds-switch__track" aria-hidden>
              <span className="ds-switch__thumb" />
            </span>
            <span className="ds-switch__label">Notify in Slack</span>
          </button>
        </div>

        <div className="ds-form-foot">
          <button type="button" className="ds-btn ds-btn--ghost">
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
