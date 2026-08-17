# Customer Incident Runbook (single-node deployment)

Scope: a single-node SQLite deployment of Mendpoint for one customer tenant,
running on Fly (app `mendpoint-talal`). This runbook covers detection, triage by
symptom, the kill switches and how to invoke them, image rollback, the disaster
recovery restore procedure, the backup fence behavior, and comms/escalation.

Every mechanism named here is real and lives in this repository. Command names
map to `package.json` scripts and the probe/paging codes below map to source in
`packages/ops`, `packages/notify`, `apps/api`, and `apps/worker`.

## 0. First 5 minutes

1. Confirm the blast radius: this is a single tenant on a single node. There is
   no failover peer. Recovery means restoring this node or rolling its image
   back, not shifting traffic.
2. Pull the two probes and the worker heartbeat (Section 1).
3. Decide the track from the symptom table (Section 2).
4. Announce in the incident channel with the probe output pasted verbatim
   (Section 7).

## 1. Detection

### Probes

- Liveness: `GET /livez` (and `/live`). Process-up only. If this fails the
  process is down or wedged; go straight to Section 4 (rollback) or restart.
- Readiness: `GET /ready`. Returns HTTP 503 when `status` is `fail`, HTTP 200
  otherwise. The body lists per-check results. Check names and meanings:
  - `env`: required environment validated. A failure here is almost always a
    misconfigured deploy; roll back (Section 4).
  - `data_dir_writable`: the SQLite data directory is writable. Failure means
    the volume is full, read-only, or unmounted.
  - `db_ping` / `db_file`: database reachable / present.
  - `db_schema`: schema check passed (when wired).
  - `last_verified_backup` (customer profile only): the most recent verified
    backup is present, authentic, and within the recovery point objective
    (3600s). Details are `current`, `overdue`, `missing_or_invalid`, or
    `not_required`. See Section 5.
- Health aggregate: `GET /healthz`.

### Paging

Critical operational events fire through the paging sink in
`packages/notify` (`notifyPaging`). It is a no-op unless `PAGING_WEBHOOK_URL`
and/or `PAGERDUTY_ROUTING_KEY` is set, so confirm those are configured for the
tenant before relying on pages. Event types and what they mean:

- `readiness_fail`: `/ready` is returning 503. Triage from the failed check
  names in the page details.
- `backup_failure`: a scheduled backup did not complete. Recovery point is
  aging; see Section 5.
- `dr_drill_fail`: a measured DR drill did not pass its targets. The restore
  path is not proven; treat as a latent recovery risk.
- `dead_letter_growth`: the worker dead-letter count is climbing. Jobs are
  failing terminally.
- `expired_lease_uncertain_side_effect`: a job lease expired while a side effect
  may have been in flight. Treat as possible partial work; do not blindly retry.
- `worker_heartbeat_stale`: the worker is not writing fresh heartbeats.

Pages are deduplicated within a window (default 5 minutes,
`PAGING_DEDUPE_WINDOW_MS`) and severity-tagged. Paging is fail-open: a paging
outage never blocks a request or job, so absence of a page is not proof of
health. Always confirm with the probes.

### Worker heartbeat

The worker writes a heartbeat JSON to `MENDPOINT_WORKER_HEARTBEAT_PATH`. Fields
that matter during an incident:

- `ok`: overall worker health.
- `recordedAt`: freshness. Compare against `feedStaleAfterMs`. A `recordedAt`
  older than the stale threshold is a stale worker.
- `recovery.deadLetter`: terminally failed jobs.
- `recovery.expiredLeases`: leases that expired mid-flight (uncertain side
  effects).

### SLO / error budget

Live SLO evidence is produced by `evaluateSloReport` in
`packages/ops/src/service-health.ts` from measured signals (readiness ratio,
request latency, job success). A `burnState` of `at_risk` or `exhausted` on any
SLO, or an overall `status` of `degraded`/`unavailable`, indicates budget burn
even when the instantaneous probe is green. Use it to decide whether to freeze
change delivery.

### Telemetry

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, traces and metrics are buffered and
exported over OTLP/HTTP (`packages/ops/src/telemetry.ts`). Both the API and the
worker flush the buffers on a fixed cadence (`MENDPOINT_TELEMETRY_FLUSH_MS`,
default 15s) and once more on graceful shutdown, so a configured collector
receives series like `readiness_check_total{status}`,
`readiness_check_duration_ms`, `service_health_total{service,status}`, and
`dr_drill_total{outcome}` — expect them to lag live signal by up to one flush
interval. Export is fail-open (a transport error is logged, never thrown), and
the whole path is a no-op — no recording, no buffering, no flush timer — when
the endpoint is unset.

## 2. Triage by symptom

| Symptom | First check | Likely track |
| --- | --- | --- |
| `/livez` fails | process down/wedged | Restart, then Section 4 rollback |
| `/ready` 503, `env` failed | bad config in this release | Section 4 rollback |
| `/ready` 503, `data_dir_writable` failed | volume full / read-only / unmounted | Fix volume, then Section 5 if data lost |
| `/ready` 503, `db_*` failed | database unreachable or corrupt | Section 5 restore |
| `/ready` 503, `last_verified_backup` `overdue`/`missing_or_invalid` | backup pipeline broken | Section 5 |
| `503 backup_in_progress` on writes | backup fence active | Section 6 (usually self-clears) |
| `feature_disabled` errors | experimental feature not enabled | Section 3 feature flags |
| `dead_letter_growth` / `expired_lease_*` pages | job failures / partial work | Section 3 worker controls |
| Probes green but SLO `exhausted` | budget burn | Section 3 freeze, investigate |

## 3. Kill switches and controls

- Backup fence (write admission): controlled by `MENDPOINT_DEPLOYMENT_PROFILE=customer`
  or `MENDPOINT_BACKUP_FENCE_ROOT`. While a backup holds the exclusive marker,
  the API returns `503 backup_in_progress` for mutating routes and synchronous
  startup fails closed with `customer_startup_blocked_by_backup`. This is
  intentional and normally clears when the backup finishes. See Section 6.
- Experimental feature gate: `assertGaOnly` throws
  `feature_disabled: <id> is experimental` for features not enabled. Enable a
  specific feature with `MENDPOINT_FEATURES=<id>`; enable all experimental
  features with `MENDPOINT_EXPERIMENTAL=1`. To disable a misbehaving experimental
  feature, remove it from `MENDPOINT_FEATURES` (or unset `MENDPOINT_EXPERIMENTAL`)
  and redeploy. GA features are always on and cannot be toggled off by flag; use
  rollback (Section 4) for a GA regression.
- Manual plan changes: gated by `MENDPOINT_MANUAL_PLAN_CHANGES_ENABLED=1`. Unset
  to withdraw the capability.
- Worker: stop the worker process to halt job and delivery side effects while you
  investigate `dead_letter_growth` or `expired_lease_uncertain_side_effect`. Do
  not mass-retry expired-lease jobs until you confirm whether the side effect
  landed; a lease expiring mid-flight means the outcome is uncertain.
- Freeze change delivery when an SLO is `exhausted`: stop the worker and hold new
  deploys until the budget recovers.

## 4. Rollback to the previous Fly image

Use this for any regression introduced by a release (failed `env` check, GA
behavior regression, latency or error-budget spike right after a deploy).

1. List releases: `fly releases -a mendpoint-talal`.
2. Identify the last known good image reference.
3. Roll back: `fly deploy -a mendpoint-talal --image <previous-image-ref>`
   (or `fly releases rollback` to the prior version).
4. Re-check `/ready` and `/livez` until `status` is `ok`.
5. Rollback restores the image, not the data. If the incident also lost or
   corrupted data, do Section 5 as well.

## 5. Disaster recovery restore

Targets (from `CORE_DISASTER_RECOVERY_POLICY`): recovery time objective 900s,
recovery point objective 3600s, drill cadence 30 days. The restore is
application-consistent (writers are fenced), encrypted (aes-256-gcm), and
verified before it is published.

### Prove the restore path first (measured drill)

Before or alongside a real restore, run the measured drill to confirm the backup
and restore mechanism is healthy and meets targets:

```
npm run dr:drill
```

This performs a real backup, restores it into an isolated temp directory,
verifies a canary record survives, and prints the measured RTO/RPO with a
PASS/FAIL against the policy targets. A FAIL (or a `dr_drill_fail` page) means do
not trust the restore path yet: investigate the backup material before
proceeding.

### Restore the node

1. Confirm which backup you are restoring. The `last_verified_backup` evidence
   records the `backupId`, `createdAt`, and authenticated manifest digest.
   Compute the recovery point: the backup age is `now - createdAt`. If it exceeds
   3600s you are outside RPO; note the data-loss window in comms.
2. Ensure you have `MENDPOINT_BACKUP_KEY` and `MENDPOINT_BACKUP_KEY_ID` for the
   tenant. Without the key the bundle cannot be decrypted or authenticated.
3. Restore into a fresh, isolated target (never over the live data dir):
   `npm run restore:customer`. The restore is atomic and refuses a target that
   already exists (`restore_target_exists`) and a target that overlaps the source
   or backup. It fails closed on any integrity mismatch
   (`backup_integrity_failed`).
4. Point the node at the restored data directory and bring it up.
5. Re-check `/ready`; `last_verified_backup` should read `current`.

## 6. Backup fence and the 503 window

While a backup runs, the exclusive fence marker is present and mutating requests
return `503 backup_in_progress`. This is expected and short-lived. Do not
disable the fence to clear the 503; that risks a torn backup.

If the 503 persists well beyond a normal backup, the fence marker may be stale
(the backup process died holding it):

1. Inspect the fence: `npm run backup:fence:inspect`. This shows the exclusive
   marker and any writer leases with their owning hostname and pid.
2. Only if the owner is confirmed dead (not on this host, or the pid is gone),
   recover the stale marker with exact evidence:
   `npm run backup:fence:recover`. Recovery refuses to reap a live owner
   (`backup_fence_recovery_owner_still_alive`) and requires the exact marker
   digest plus owner-termination evidence. Never force-delete fence files by
   hand.

## 7. Comms and escalation

- Open the incident channel and paste the raw `/ready` body and the worker
  heartbeat. State the track (rollback, restore, or fence) and the current
  recovery point if data is involved.
- If a restore is needed, state the RPO window (backup age) so the customer
  knows the maximum possible data-loss span up front.
- Escalate to the on-call owner when: `/livez` is failing, a restore is required,
  a DR drill fails, or an SLO is `exhausted` with no clear cause.
- Record the timeline for the postmortem: detection source (probe or page),
  action taken, image or backup id used, and the measured recovery time.

## 8. Post-incident

- If a real restore ran, run `npm run dr:drill` again to reconfirm the restore
  path and refresh the measured RTO/RPO evidence.
- If the drill or a real restore missed a target, file the gap: the single-node
  tier has no failover, so RTO is bounded by restore-plus-boot time on one node.
- Re-enable any capability you withdrew (feature flags, manual plan changes,
  worker) only after the SLO burn state returns to `healthy`.
