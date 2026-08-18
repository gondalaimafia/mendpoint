/**
 * Effective verification-isolation backend, shaped for the /status probe.
 *
 * Surfacing the resolved sandbox kind makes a misconfigured
 * MENDPOINT_SANDBOX_KIND (e.g. a typo that would route verification to the host)
 * visible before the first verification runs. resolveSandboxKind throws on a
 * set-but-unrecognized value; this reports that as an error rather than letting
 * the /status handler fall over.
 */
import { resolveSandboxKind } from "@mendpoint/platform";

export type SandboxStatus = {
  /** The effective backend, or null when the configured value cannot resolve. */
  kind: string | null;
  /** The raw MENDPOINT_SANDBOX_KIND value, or null when unset (defaults local). */
  configured: string | null;
  /** False when the configured value is set but unrecognized. */
  ok: boolean;
  /** Present only when resolution failed. */
  error?: string;
};

export function sandboxStatus(): SandboxStatus {
  const configured = process.env.MENDPOINT_SANDBOX_KIND ?? null;
  try {
    return { kind: resolveSandboxKind(), configured, ok: true };
  } catch (e) {
    return {
      kind: null,
      configured,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
