import type { ReviewDecision } from "./interactions.js";

/**
 * A tiny module-level observable (same shape as `toastStore`) so any client
 * control — the shell's topbar "Approve" CTA and the PR detail's secondary
 * "Request changes" / "Reject" buttons — can open the one shared review dialog
 * without threading React context. The dialog (mounted once in `ConsoleShell`)
 * subscribes here.
 */

export type ReviewDialogState = { prId: string; decision: ReviewDecision } | null;

type Listener = (state: ReviewDialogState) => void;

class ReviewDialogStore {
  private state: ReviewDialogState = null;
  private listeners = new Set<Listener>();

  getSnapshot(): ReviewDialogState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(prId: string, decision: ReviewDecision): void {
    this.state = { prId, decision };
    this.emit();
  }

  close(): void {
    this.state = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

export const reviewDialogStore = new ReviewDialogStore();

/** Open the shared review dialog for a PR and a preset decision. */
export function openReviewDialog(prId: string, decision: ReviewDecision): void {
  reviewDialogStore.open(prId, decision);
}
