# Ingest DEPENDS_ON from package manifests

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

DEPENDS_ON was a declared Change Graph edge kind with readers
(`enumerateDependencyPaths`, `migration_ready_units`) and no producer. Those
queries had to fail closed so an empty relation could not vacuously mark every
migration unit ready. Spec §11 and §28.1.1 require important edges to have
evidence/provenance.

## Decision

1. **Writer.** `ingestManifestDependencies` parses workspace `package.json`,
   `pyproject.toml`, or `go.mod` and writes Service nodes plus DEPENDS_ON edges
   (source_system `manifest`). Service ids are repo-namespaced
   (`service:${repoId}:${name}`, mirroring `symbol:${repoId}:...`) so a declared
   dependency cannot collide with a provider Service (`service:${slug}`) or
   across tenants/repos. Each edge records the manifest block it came from
   (`dependencies` / `peerDependencies` / `require`). Malformed names/files are
   skipped, never guessed, and the result carries an explicit `skipped` state
   with a reason (`no-manifest` / `unparseable` / `no-package-name`). Self-edges
   and path-like names are rejected.
2. **Live path.** `ingestLspSymbols` (AST fallback and heuristic file ingest)
   calls the writer, so a repository walk populates the relation.
3. **Readiness query.** `migration_ready_units` fails closed unless the tenant
   graph holds at least one MigrationUnit -> MigrationUnit DEPENDS_ON edge — the
   exact relation readiness walks. The manifest writer emits only
   Service -> Service edges, so it does not by itself open the gate; readiness
   waits for a MigrationUnit dependency producer. When that relation is
   populated the query returns units whose dependencies are `complete`/`done`.
   The planner tool surface and query-picker rule are restored together (the op
   answers `target_absent` honestly until a MigrationUnit producer lands).

## Alternatives considered

- **Keep the stub forever.** Rejected: the declared traversals would stay empty
  in production.
- **Treat empty outgoing deps as ready without a populated relation.** Rejected:
  that is the vacuous-true bug the stub existed to prevent.

## Security impact

Package names are bounded and reject `..` / path separators. Service ids are
repo-namespaced so manifest ingest cannot clobber another tenant's or the
provider's Service node (which would strip its `tenant_id`/`tier` and reassign
ownership). Nodes carry `repo_id` (and optional `tenant_id`) so the tenant graph
view can include them. No execution of manifest scripts.

## Data and compatibility impact

Additive graph writes only. Existing fail-closed tests still hold when no
DEPENDS_ON edges exist.

## Migration plan

1. Add the writer + lsp wiring.
2. Compute readiness when the relation is populated.
3. Re-advertise `migration_ready_units` on the planner surface.

## Rollback

Revert the commit. DEPENDS_ON is again unpopulated; the query fails closed;
the planner no longer offers the op.

## Evaluation plan

Success is the manifest ingest suite plus the existing empty-relation fail-closed
test. Reconsideration is a PRESERVES_INVARIANT producer for `invariants_for_symbol`.
