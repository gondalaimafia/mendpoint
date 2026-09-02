/**
 * Customer production backup staleness watchdog — CI step / cron.
 *
 * The gap this closes
 * -------------------
 * `.github/workflows/customer-backup.yml` alerts with `if: failure()` INSIDE its
 * job, so it can only report "a run executed and failed". It cannot report "a
 * run never happened". GitHub's scheduler drops high-frequency crons, and the
 * backup's cron cadence was dropped badly enough that hours pass with no run at
 * all. Every run that DID execute reported success, so no failure fired, no issue
 * was opened, and the silence read as health.
 *
 * The primary trigger has since moved onto the machine
 * (scripts/customer-backup-scheduler.ts, at a cadence derived from the RPO), so
 * the cron here is a dead-machine fallback. That does not retire this watchdog:
 * it is now driven by the case the on-machine scheduler cannot cover, a machine
 * that is not running or a scheduler that is parked. This checker never assumed a
 * particular delivery interval -- it measures the AGE of the newest verified
 * backup against the RPO, so it reads the same whichever trigger last fired.
 *
 * That silence is not cosmetic. `assessCustomerBackupReadiness` turns the
 * `last_verified_backup` readiness check red once the newest backup is older
 * than the policy RPO; `/healthz` and `/readyz` are the same handler; and a red
 * `/healthz` makes the post-rotation probe in sandbox-egress-acceptance.yml
 * contain (stop) the customer machines. A skipped backup can therefore hard-stop
 * customer production, with nothing having failed anywhere.
 *
 * The shape of the fix (modelled on scripts/check-sandbox-egress-freshness.ts)
 * ---------------------------------------------------------------------------
 * Expiry-driven, not run-driven. The alarm is computed from the age of the
 * newest verified backup, so a skipped run and a failed run produce the SAME
 * alarm. Nothing about this check consults workflow run history.
 *
 * Freshness-only, NOT verification. The watchdog runs in CI and deliberately
 * does not hold `MENDPOINT_BACKUP_KEY`, so it cannot and does not re-verify the
 * evidence HMAC. The authenticated verification that actually gates readiness
 * lives in `assessCustomerBackupReadiness` (packages/ops/src/disaster-recovery.ts)
 * and is unchanged. This check answers one narrower question: is the newest
 * backup the machine can show us within the RPO?
 *
 * Three-valued by construction
 * ----------------------------
 * The verdict type has THREE states, never two: `fresh`, `stale`, and
 * `indeterminate`. "We could not determine the backup age" is its own state with
 * its own named reason, and it alarms exactly as loudly as a proven-stale
 * backup. A watchdog that reports "fine" because it could not look is worse than
 * no watchdog, so there is no code path from a failed read to `fresh`.
 *
 * Secret hygiene: the evidence document carries `keyId` and an `integrity.digest`
 * derived from the backup key. Neither the report this writes nor anything it
 * logs contains the raw document, the digest, or the key id — only the backup
 * identity and timing fields needed to explain the verdict.
 *
 * Exit code: 0 only when the backup is provably fresh; 1 for stale AND for every
 * indeterminate reason, so the calling step fails loudly either way.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_DISASTER_RECOVERY_POLICY } from "@mendpoint/ops";

/**
 * Every distinct way this check can fail to reach an answer. Each is reported
 * under its own name so an operator can tell "the machine is stopped" from "the
 * evidence file is corrupt" without reading the raw capture, and so no two
 * causes can be conflated into one vague bucket.
 */
export const BACKUP_FRESHNESS_INDETERMINATE_REASONS = [
  /** The remote read's exit status never reached us (step crashed, output lost). */
  "capture_status_unknown",
  /** The remote read exited non-zero: ssh refused, machine stopped, file absent, timed out. */
  "remote_read_failed",
  /** The read "succeeded" but produced nothing — flyctl can mask a remote failure this way. */
  "evidence_empty",
  /** Captured bytes are not JSON. */
  "evidence_unparseable",
  /** Parsed, but not a JSON object (array, null, scalar). */
  "evidence_not_object",
  /** No integrity block: this was not written by the authenticated evidence writer. */
  "integrity_block_absent",
  /** No backupId: the document cannot identify which backup it describes. */
  "backup_id_absent",
  "created_at_absent",
  "created_at_unparseable",
  "verified_at_absent",
  "verified_at_unparseable",
  /** Verification claims to predate the backup it verified. */
  "verification_precedes_creation",
  /** A timestamp is in the future relative to `now` — clocks disagree, ages are meaningless. */
  "clock_skew_future",
  /** The `now` handed to the assessment is not a readable instant. */
  "now_unreadable",
  /** The RPO threshold is not a usable positive number of seconds. */
  "rpo_unreadable",
] as const;

export type BackupFreshnessIndeterminateReason =
  (typeof BACKUP_FRESHNESS_INDETERMINATE_REASONS)[number];

/**
 * What the remote read produced. Both fields are explicitly nullable because
 * "no status" and "no bytes" are real, distinct outcomes that must not be
 * defaulted into the reassuring value.
 */
export interface BackupEvidenceCapture {
  /** Exit status of the remote read; null when it was never observed. */
  readonly status: number | null;
  /** Raw captured text; null when nothing was captured at all (distinct from ""). */
  readonly text: string | null;
}

export type BackupFreshnessVerdict =
  | {
      readonly state: "fresh";
      readonly summary: string;
      readonly ageSeconds: number;
      readonly rpoSeconds: number;
      readonly backupId: string;
      readonly createdAt: string;
      readonly verifiedAt: string;
    }
  | {
      readonly state: "stale";
      readonly summary: string;
      readonly ageSeconds: number;
      readonly rpoSeconds: number;
      readonly backupId: string;
      readonly createdAt: string;
      readonly verifiedAt: string;
    }
  | {
      readonly state: "indeterminate";
      readonly summary: string;
      readonly reason: BackupFreshnessIndeterminateReason;
      readonly rpoSeconds: number;
    };

function indeterminate(
  reason: BackupFreshnessIndeterminateReason,
  summary: string,
  rpoSeconds: number,
): BackupFreshnessVerdict {
  return { state: "indeterminate", reason, summary, rpoSeconds };
}

/**
 * The RPO the readiness check measures against, read from the one policy that
 * defines it rather than restated here. `assessCustomerBackupReadiness` compares
 * the backup age against `input.policy.rpoSeconds`, and `customerBackupInputFromEnv`
 * always returns `CORE_DISASTER_RECOVERY_POLICY` as that policy — so this is the
 * same 3600s and cannot drift from what actually turns `/healthz` red.
 */
export function resolveBackupRpoSeconds(): number {
  return CORE_DISASTER_RECOVERY_POLICY.rpoSeconds;
}

/**
 * Decide whether the newest verified backup is inside the RPO.
 *
 * The age is measured from `createdAt`, deliberately matching
 * `assessCustomerBackupReadiness`: that is the quantity which turns
 * `last_verified_backup` red, so this alarm fires on the same clock as the
 * consequence it exists to pre-empt. `verifiedAt` is still required and still
 * order-checked, because evidence that cannot say when it was verified is not
 * evidence of a verified backup.
 */
export function assessBackupEvidenceFreshness(input: {
  capture: BackupEvidenceCapture;
  now: string;
  rpoSeconds: number;
}): BackupFreshnessVerdict {
  const rpoSeconds = input.rpoSeconds;
  if (!Number.isFinite(rpoSeconds) || rpoSeconds <= 0) {
    return indeterminate(
      "rpo_unreadable",
      `Backup RPO threshold is unusable (${String(rpoSeconds)}); backup age cannot be judged`,
      0,
    );
  }

  const nowMs = new Date(input.now).getTime();
  if (!Number.isFinite(nowMs)) {
    return indeterminate(
      "now_unreadable",
      `Current time is unreadable (${input.now}); backup age cannot be computed`,
      rpoSeconds,
    );
  }

  if (input.capture.status === null || !Number.isFinite(input.capture.status)) {
    return indeterminate(
      "capture_status_unknown",
      "The backup evidence read reported no exit status; the backup age is unknown, NOT fine",
      rpoSeconds,
    );
  }
  if (input.capture.status !== 0) {
    return indeterminate(
      "remote_read_failed",
      `Reading backup evidence from the customer machine failed (exit ${input.capture.status}); the backup age is unknown, NOT fine`,
      rpoSeconds,
    );
  }
  if (input.capture.text === null || input.capture.text.trim() === "") {
    return indeterminate(
      "evidence_empty",
      "The backup evidence read returned no content; the backup age is unknown, NOT fine",
      rpoSeconds,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.capture.text);
  } catch {
    return indeterminate(
      "evidence_unparseable",
      "Backup evidence is not valid JSON; the backup age is unknown, NOT fine",
      rpoSeconds,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return indeterminate(
      "evidence_not_object",
      "Backup evidence is not a JSON object; the backup age is unknown, NOT fine",
      rpoSeconds,
    );
  }

  const evidence = parsed as Record<string, unknown>;
  const integrity = evidence.integrity;
  if (
    typeof integrity !== "object" ||
    integrity === null ||
    typeof (integrity as Record<string, unknown>).digest !== "string" ||
    typeof (integrity as Record<string, unknown>).algorithm !== "string"
  ) {
    return indeterminate(
      "integrity_block_absent",
      "Backup evidence carries no integrity block; it was not written by the authenticated backup, so its age proves nothing",
      rpoSeconds,
    );
  }

  const backupId = evidence.backupId;
  if (typeof backupId !== "string" || backupId.trim() === "") {
    return indeterminate(
      "backup_id_absent",
      "Backup evidence names no backupId; it cannot identify the backup it describes",
      rpoSeconds,
    );
  }

  const createdAt = evidence.createdAt;
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    return indeterminate(
      "created_at_absent",
      "Backup evidence has no createdAt; the backup age cannot be computed",
      rpoSeconds,
    );
  }
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) {
    return indeterminate(
      "created_at_unparseable",
      `Backup evidence createdAt is unreadable (${createdAt}); the backup age cannot be computed`,
      rpoSeconds,
    );
  }

  const verifiedAt = evidence.verifiedAt;
  if (typeof verifiedAt !== "string" || verifiedAt.trim() === "") {
    return indeterminate(
      "verified_at_absent",
      "Backup evidence has no verifiedAt; nothing proves this backup was ever verified",
      rpoSeconds,
    );
  }
  const verifiedMs = new Date(verifiedAt).getTime();
  if (!Number.isFinite(verifiedMs)) {
    return indeterminate(
      "verified_at_unparseable",
      `Backup evidence verifiedAt is unreadable (${verifiedAt}); nothing proves this backup was ever verified`,
      rpoSeconds,
    );
  }

  if (verifiedMs < createdMs) {
    return indeterminate(
      "verification_precedes_creation",
      `Backup evidence claims verification (${verifiedAt}) before creation (${createdAt}); the document is incoherent and its age proves nothing`,
      rpoSeconds,
    );
  }
  if (createdMs > nowMs || verifiedMs > nowMs) {
    return indeterminate(
      "clock_skew_future",
      `Backup evidence is dated in the future (createdAt ${createdAt}, verifiedAt ${verifiedAt}, now ${input.now}); clocks disagree and the backup age is meaningless`,
      rpoSeconds,
    );
  }

  const ageSeconds = Math.floor((nowMs - createdMs) / 1_000);
  if (ageSeconds <= rpoSeconds) {
    return {
      state: "fresh",
      summary: `Newest verified customer backup ${backupId} is ${ageSeconds}s old, inside the ${rpoSeconds}s RPO`,
      ageSeconds,
      rpoSeconds,
      backupId,
      createdAt,
      verifiedAt,
    };
  }
  return {
    state: "stale",
    summary: `Newest verified customer backup ${backupId} is ${ageSeconds}s old, PAST the ${rpoSeconds}s RPO — backups have stopped happening`,
    ageSeconds,
    rpoSeconds,
    backupId,
    createdAt,
    verifiedAt,
  };
}

/**
 * Build the capture from the environment the workflow step leaves behind.
 *
 * Both "no status was recorded" and "no capture file exists" resolve to the
 * nullable fields rather than to a benign default, so a step that half-ran
 * lands in `capture_status_unknown` / `evidence_empty` and alarms.
 */
export function resolveBackupEvidenceCapture(
  env: NodeJS.ProcessEnv,
): BackupEvidenceCapture {
  const rawStatus = env.MENDPOINT_BACKUP_EVIDENCE_CAPTURE_STATUS?.trim();
  const parsedStatus = rawStatus ? Number(rawStatus) : Number.NaN;
  const status = Number.isFinite(parsedStatus) ? parsedStatus : null;

  const capturePath = env.MENDPOINT_BACKUP_EVIDENCE_CAPTURE_PATH?.trim();
  if (!capturePath) return { status, text: null };
  try {
    return { status, text: readFileSync(capturePath, "utf8") };
  } catch {
    return { status, text: null };
  }
}

/**
 * The verdict as written to disk for the alerting step. Redacted by
 * construction: it is built field by field from the verdict union, so the
 * evidence document's `keyId` and `integrity.digest` can never reach it.
 */
export function redactedReport(
  verdict: BackupFreshnessVerdict,
  now: string,
): Record<string, unknown> {
  const common = { checkedAt: now, state: verdict.state, summary: verdict.summary, rpoSeconds: verdict.rpoSeconds };
  return verdict.state === "indeterminate"
    ? { ...common, reason: verdict.reason }
    : {
        ...common,
        ageSeconds: verdict.ageSeconds,
        backupId: verdict.backupId,
        createdAt: verdict.createdAt,
        verifiedAt: verdict.verifiedAt,
      };
}

export function writeReport(path: string, report: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const verdict = assessBackupEvidenceFreshness({
    capture: resolveBackupEvidenceCapture(process.env),
    now,
    rpoSeconds: resolveBackupRpoSeconds(),
  });

  const reportPath =
    process.env.MENDPOINT_BACKUP_FRESHNESS_REPORT_PATH?.trim() ||
    "test-results/customer-backup-watchdog/verdict.json";
  writeReport(reportPath, redactedReport(verdict, now));

  if (verdict.state === "fresh") {
    console.log(`customer_backup_fresh ${verdict.summary}`);
    return;
  }
  // Stale and indeterminate are equally loud on purpose: the whole point of this
  // watchdog is that "we could not look" must never be quieter than "it is bad".
  console.error(
    verdict.state === "stale"
      ? `customer_backup_stale ${verdict.summary}`
      : `customer_backup_indeterminate reason=${verdict.reason} ${verdict.summary}`,
  );
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
