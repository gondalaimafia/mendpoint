"use client";

import React from "react";
import { useRouter } from "next/navigation";
import {
  REVIEW_DECISION_META,
  pushReviewSuccessToast,
  submitPrReview,
} from "./interactions.js";
import { reviewDialogStore, type ReviewDialogState } from "./review-dialog-store.js";

/**
 * The one review dialog, mounted once by `ConsoleShell`. It watches the shared
 * `reviewDialogStore`; when a control opens it, it collects a required rationale
 * and records a real decision via `submitPrReview`. It disables its controls
 * while the request is in flight, shows the API's error in place on failure (no
 * success toast), and on success fires the honest "recorded" toast and closes.
 * Focus is trapped and restored, and Esc / overlay-click cancel — matching the
 * app-native dialog conventions.
 */
export function ReviewDialog() {
  const router = useRouter();
  const [state, setState] = React.useState<ReviewDialogState>(() =>
    reviewDialogStore.getSnapshot(),
  );
  const [rationale, setRationale] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => reviewDialogStore.subscribe(setState), []);

  const open = state !== null;

  // Reset the form whenever a fresh dialog opens.
  React.useEffect(() => {
    if (open) {
      setRationale("");
      setError(null);
      setBusy(false);
    }
  }, [open, state?.prId, state?.decision]);

  const close = React.useCallback(() => {
    if (busy) return;
    reviewDialogStore.close();
  }, [busy]);

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    textareaRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, close]);

  if (!state) return null;

  const meta = REVIEW_DECISION_META[state.decision];
  const canSubmit = rationale.trim().length >= 3 && !busy;

  async function onSubmit() {
    if (!state) return;
    if (rationale.trim().length < 3) {
      setError("Add a rationale of at least 3 characters before recording a decision.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitPrReview(state.prId, state.decision, rationale.trim());
      pushReviewSuccessToast(state.decision);
      reviewDialogStore.close();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the review. Try again.");
      setBusy(false);
    }
  }

  return (
    <div
      className="ds-dialog__overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="ds-dialog fade-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <h2 id={titleId} className="ds-dialog__title">
          {meta.dialogTitle}
        </h2>
        <p id={descId} className="ds-dialog__desc">
          Recording a decision does not merge anything. Merging stays a human action in GitHub.
        </p>
        <div className="ds-field">
          <label className="ds-field__label" htmlFor="review-rationale">
            Rationale
          </label>
          <textarea
            id="review-rationale"
            ref={textareaRef}
            className="ds-input"
            rows={3}
            value={rationale}
            disabled={busy}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Why this decision? (required)"
          />
          <span className="ds-field__hint">
            Attached to the review record. At least 3 characters.
          </span>
        </div>
        {error && (
          <p className="ds-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="ds-dialog__actions">
          <button
            type="button"
            className="ds-btn ds-btn--ghost"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--primary indigo-glow"
            onClick={onSubmit}
            disabled={!canSubmit}
            aria-busy={busy}
          >
            {busy ? "Recording…" : meta.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
