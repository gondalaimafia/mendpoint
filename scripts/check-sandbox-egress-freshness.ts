/**
 * Sandbox egress receipt freshness monitor — npm-invokable / CI step / cron.
 *
 * A fresh receipt is both a boot requirement and a readiness condition, so a
 * renewal that fails silently (a failed scheduled run, or one that never ran) is
 * equivalent to no renewal. This monitor makes that loud BEFORE the receipt
 * lapses: it reads the receipt's own claimed expiry and pages once the receipt
 * is within a lead window of expiry (or already past it).
 *
 * It is driven by the receipt's expiry, not by whether a renewal ran, so it
 * catches both a failed renewal and a skipped one. Run it:
 *   - as the final self-check of the renewal workflow (proves the freshly minted
 *     receipt has healthy margin), and
 *   - as a standalone monitor against a deployed app that carries the receipt.
 *
 * Freshness-only, NOT verification: the claimed expiry is read to decide whether
 * to alert. The cryptographic verification that actually gates execution lives
 * in packages/platform/src/fly-sandbox.ts and is unchanged.
 *
 * Exit code: 0 when the receipt has healthy margin; 1 when a page was warranted
 * (approaching, lapsed, or unreadable) so the calling step also fails loudly.
 */
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pagingEventForEgressReceipt, pageEgressReceiptFreshness } from "@mendpoint/notify";

const DEFAULT_ALERT_LEAD_MS = 6 * 60 * 60 * 1000; // one renewal cadence of margin

export function resolveAlertLeadMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MENDPOINT_SANDBOX_EGRESS_ALERT_LEAD_MS?.trim();
  if (!raw) return DEFAULT_ALERT_LEAD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_LEAD_MS;
}

/**
 * Resolve the receipt's claimed expiry from configuration. Prefers the explicit
 * `MENDPOINT_SANDBOX_EGRESS_EXPIRES_AT`; falls back to reading `expiresAt` from
 * the attestation envelope payload (freshness only, no signature check). Returns
 * an empty string when neither is available, which the caller treats as an
 * unreadable-freshness alarm rather than a pass.
 */
export function resolveReceiptExpiry(env: NodeJS.ProcessEnv): string {
  const explicit = env.MENDPOINT_SANDBOX_EGRESS_EXPIRES_AT?.trim();
  if (explicit) return explicit;
  const attestation = env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64?.trim();
  if (!attestation) return "";
  try {
    const envelope = JSON.parse(Buffer.from(attestation, "base64").toString("utf8"));
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    return typeof payload.expiresAt === "string" ? payload.expiresAt : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const expiresAt = resolveReceiptExpiry(process.env);
  const now = new Date().toISOString();
  const leadMs = resolveAlertLeadMs(process.env);
  const event = pagingEventForEgressReceipt({ expiresAt, now, leadMs });
  if (!event) {
    console.log(`sandbox_egress_receipt_fresh expiresAt=${expiresAt} leadMs=${leadMs}`);
    return;
  }
  console.error(`sandbox_egress_receipt_alarm ${event.summary}`);
  await pageEgressReceiptFreshness({ expiresAt, now, leadMs });
  process.exitCode = 1;
}

function isMain(): boolean {
  return Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
