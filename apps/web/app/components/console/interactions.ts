import { pushToast, type ToastPayload } from "./toast.js";

/**
 * Console review interactions. These used to fire decorative toasts that
 * fabricated results (most seriously, an "Approve & merge" click that claimed a
 * pull request had merged when nothing happened). Mendpoint is review-first and
 * never merges by design, so the real primary action is recording a human
 * review DECISION. Each control below posts a genuine decision to the API
 * (through the same-origin `/api/[...path]` proxy) and surfaces exactly what
 * happened — a decision was recorded, not a merge. This module is the single
 * source of truth the review dialog and the tests both reference.
 */

/** The review decisions the console exposes. The API also supports `regenerate`
 * and `waive`, but neither has a console control yet (waive additionally needs a
 * waiver-expiry input the console does not collect). */
export const REVIEW_DECISIONS = ["approve", "request_changes", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

type ReviewDecisionMeta = {
  /** Label on the control that opens the review dialog. */
  actionLabel: string;
  /** Dialog heading. */
  dialogTitle: string;
  /** Dialog submit button label. */
  submitLabel: string;
  /** Honest success toast: a decision was RECORDED. Nothing is merged here. */
  success: ToastPayload;
};

export const REVIEW_DECISION_META: Record<ReviewDecision, ReviewDecisionMeta> = {
  approve: {
    actionLabel: "Approve",
    dialogTitle: "Approve this pull request?",
    submitLabel: "Record approval",
    success: {
      title: "Approval recorded",
      description: "Your approval is on the record. Merging stays a human action in GitHub.",
    },
  },
  request_changes: {
    actionLabel: "Request changes",
    dialogTitle: "Request changes on this pull request?",
    submitLabel: "Request changes",
    success: {
      title: "Changes requested",
      description: "Your request for changes is on the record.",
    },
  },
  reject: {
    actionLabel: "Reject",
    dialogTitle: "Reject this pull request?",
    submitLabel: "Record rejection",
    success: {
      title: "Rejection recorded",
      description: "Your rejection is on the record.",
    },
  },
};

/** Maps the API/proxy error codes to reviewer-facing sentences. */
const REVIEW_ERROR_MESSAGES: Record<string, string> = {
  review_rationale_invalid: "Add a rationale of at least 3 characters before recording a decision.",
  review_decision_invalid: "That review decision is not recognized.",
  review_candidate_not_found: "There is no candidate to review for this pull request yet.",
  domain_event_idempotency_conflict: "This review was already recorded.",
  human_review_identity_required: "Only a signed-in human reviewer can record a decision.",
  review_attributed_identity_required: "Only a signed-in human reviewer can record a decision.",
  web_session_required: "Your session expired. Sign in again to record a review.",
  cross_origin_request_rejected: "This review could not be recorded from here.",
  rbac_denied: "Your role cannot record reviews on pull requests.",
  "not found": "This pull request is no longer available.",
};

export function reviewErrorMessage(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(REVIEW_ERROR_MESSAGES, code)) {
    return REVIEW_ERROR_MESSAGES[code]!;
  }
  return "Could not record the review. Try again.";
}

/**
 * Records a real human review decision through the same-origin API proxy
 * (`POST /api/prs/:id/reviews`). Resolves on success; rejects with a
 * reviewer-facing message on failure. Never claims a merge — recording a
 * decision is all this does.
 */
export async function submitPrReview(
  prId: string,
  decision: ReviewDecision,
  rationale: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/prs/${encodeURIComponent(prId)}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, rationale }),
    });
  } catch {
    throw new Error("Could not reach the review service. Check your connection and try again.");
  }
  if (!res.ok) {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      code = null;
    }
    throw new Error(reviewErrorMessage(code));
  }
}

/** Pushes the honest success toast for a recorded decision. */
export function pushReviewSuccessToast(decision: ReviewDecision): void {
  pushToast(REVIEW_DECISION_META[decision].success);
}
