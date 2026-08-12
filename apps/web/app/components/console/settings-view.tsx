"use client";

import React from "react";
import { CheckIcon, ChevronDownIcon, SectionLabel } from "../ds/index.js";
import { saveSettings } from "./interactions.js";

/**
 * `/settings` — workspace settings, capped at 640px. Two cards: spec source (a
 * mono URL input and a target-version select) and pull requests (a "drafts"
 * checkbox with its consequence line and two switches). Save is the single
 * indigo CTA; Cancel is ghost. Save fires a confirmation toast.
 */
export function SettingsView() {
  const [drafts, setDrafts] = React.useState(true);
  const [autoOpen, setAutoOpen] = React.useState(true);
  const [notifySlack, setNotifySlack] = React.useState(false);

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
              defaultValue="https://api.acme.dev/openapi.yaml"
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
                defaultValue="v3.0.0"
              >
                <option>v3.0.0</option>
                <option>v2.9.4</option>
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
          <button
            type="button"
            className="ds-btn ds-btn--primary indigo-glow"
            onClick={saveSettings}
          >
            Save changes
          </button>
          <button type="button" className="ds-btn ds-btn--ghost">
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
