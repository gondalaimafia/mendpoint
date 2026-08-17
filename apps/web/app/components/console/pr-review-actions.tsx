"use client";

import React from "react";
import { REVIEW_DECISION_META } from "./interactions.js";
import { openReviewDialog } from "./review-dialog-store.js";

/**
 * The PR detail's secondary review controls. Approve is the shell's single
 * indigo topbar CTA; the corrective decisions live here next to the diff as
 * outline buttons. Each opens the shared review dialog (which collects the
 * required rationale and records the real decision) — none fabricates a result.
 */
export function PrReviewActions({ prId }: { prId: string }) {
  return (
    <>
      <button
        type="button"
        className="ds-btn ds-btn--outline"
        onClick={() => openReviewDialog(prId, "request_changes")}
      >
        {REVIEW_DECISION_META.request_changes.actionLabel}
      </button>
      <button
        type="button"
        className="ds-btn ds-btn--outline"
        onClick={() => openReviewDialog(prId, "reject")}
      >
        {REVIEW_DECISION_META.reject.actionLabel}
      </button>
    </>
  );
}
