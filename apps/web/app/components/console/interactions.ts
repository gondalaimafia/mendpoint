import { pushToast, type ToastPayload } from "./toast.js";

/**
 * The exact toast payloads the Step-5 interactions fire, kept as named exports
 * so the wiring (dialog confirm / approve-merge click) and the tests reference
 * one source of truth.
 */

export const OPEN_ALL_TOAST: ToastPayload = {
  title: "42 pull requests opened",
  description: "across 42 repositories",
};

export function mergeToast(prNumber: number): ToastPayload {
  return { title: `PR #${prNumber} merged` };
}

export const SETTINGS_SAVED_TOAST: ToastPayload = {
  title: "Settings saved",
  description: "Spec source and pull request defaults updated",
};

/** Confirm handler for the "Open all PRs" alert dialog. */
export function confirmOpenAllPrs(): void {
  pushToast(OPEN_ALL_TOAST);
}

/** Handler for the "Approve & merge" primary action on a PR. */
export function approveAndMerge(prNumber: number): void {
  pushToast(mergeToast(prNumber));
}

/** Handler for the settings "Save changes" primary action. */
export function saveSettings(): void {
  pushToast(SETTINGS_SAVED_TOAST);
}
