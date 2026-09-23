# Revert obligation ledger

A revert removes capability without breaking a build, so the promise to bring
that capability back has no forcing function. `npm run reverts:check`
(`scripts/revert-obligation-check.ts`) gives it one: every revert on `main` is an
open obligation until it is discharged, and an undischarged one becomes a hard
failure after a grace period.

An obligation is discharged automatically when the reverted work is **re-landed**
or when an **Accepted ADR** under `docs/adr/` names the removed files. When
neither applies — the work was deliberately superseded and will not be brought
back — record that decision here with a greppable marker:

```
revert-obligation: <commit-sha> <reason>
```

Audit every recorded decision in one command:

```
grep -rn "revert-obligation:" .
```

## Recorded decisions not to restore

- revert-obligation: 6a7b2f6 Restore last known healthy production source (#93) reverted the
  post-2abe3ff self-serve slices during a production crash-loop. The self-serve foundation was
  then deliberately superseded by the "Scope correction: complete local features, still unshipped"
  reintegration recorded in tasks/todo.md (2026-08-12 / 2026-08-13 sections): the kept capabilities
  were re-integrated as complete local application paths, and the remainder is intentionally not
  restored. This is a settled decision, not a deferred one.

- revert-obligation: f8d0905 Revert #602: in-process backup scheduler blocks the worker's startup
  lease at boot (#615) removed the boot-time backup scheduler, the child supervisor and the customer
  boot sequence (scripts/customer-backup-scheduler.ts, scripts/child-supervisor.ts,
  scripts/customer-boot-sequence.ts) after they crash-looped production on 2026-09-02: the catch-up
  backup fired at boot, took the exclusive fence, and the worker's startup lease then refused. That
  design is not restored as reverted. Backup cadence is delivered from outside the process by the
  customer backup delivery controller (#637); the watchdog's machine-start step (#660) and the
  boot-path hardening against an orphaned fence (#661) were open pull requests when this decision
  was recorded, for incident #659. An in-process trigger may return only under a redesign that never
  holds the fence while startup admission is pending, which is a new decision for the owner, not a
  re-land of this commit.
