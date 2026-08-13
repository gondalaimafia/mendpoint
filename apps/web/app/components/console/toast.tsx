"use client";

import React from "react";

/**
 * Minimal DS-styled toast surface — the app has no `sonner`, so this is the
 * app-native equivalent the handoff (Step 5) calls for. One store, one at a
 * time, bottom-right. The store is a plain module-level observable so any client
 * component can `pushToast` without threading context, and so the toast payloads
 * are unit-testable without a DOM.
 */

export type ToastPayload = {
  title: string;
  description?: string;
};

type ToastItem = ToastPayload & { id: number };

type Listener = (toasts: ToastItem[]) => void;

const AUTODISMISS_MS = 4000;

class ToastStore {
  private toasts: ToastItem[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  getSnapshot(): ToastItem[] {
    return this.toasts;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(payload: ToastPayload): number {
    const id = ++this.seq;
    // One at a time: the newest replaces whatever was showing.
    this.toasts = [{ ...payload, id }];
    this.emit();
    return id;
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  clear(): void {
    this.toasts = [];
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.toasts);
  }
}

export const toastStore = new ToastStore();

/** Push a toast onto the shared store. Safe to call from any client component. */
export function pushToast(payload: ToastPayload): number {
  return toastStore.push(payload);
}

/** Mounts once (in ConsoleShell) and renders whatever the store is showing. */
export function Toaster() {
  const [toasts, setToasts] = React.useState<ToastItem[]>(() =>
    toastStore.getSnapshot(),
  );

  React.useEffect(() => toastStore.subscribe(setToasts), []);

  React.useEffect(() => {
    if (toasts.length === 0) return;
    const latest = toasts[toasts.length - 1]!;
    const timer = window.setTimeout(
      () => toastStore.dismiss(latest.id),
      AUTODISMISS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="ds-toaster" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className="ds-toast fade-up" role="status">
          <div className="ds-toast__title">{toast.title}</div>
          {toast.description && (
            <div className="ds-toast__desc">{toast.description}</div>
          )}
          <button
            type="button"
            className="ds-toast__close"
            aria-label="Dismiss notification"
            onClick={() => toastStore.dismiss(toast.id)}
          >
            <span aria-hidden>×</span>
          </button>
        </div>
      ))}
    </div>
  );
}
