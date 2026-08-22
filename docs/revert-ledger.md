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
