# Change Graph incremental publication

1. Bind the previous graph version and exact repository and provider revisions.
2. Compute changed files, provider surfaces, and affected call-graph regions.
3. Reuse unchanged content-addressed entities and relationships.
4. Re-run entity resolution and extractors only for affected regions and dependent aliases.
5. Recompute coverage and conflicts for the complete declared scope.
6. Validate endpoints, evidence, tenant scope, bounds, and deterministic digest.
7. Publish the successor atomically and compare-and-set the head.

Deletion closes or supersedes relationships in the new version; it never edits a historical version. Structural, import, hierarchy, provider-version, or alias changes may require a wider reset. If validation or publication fails, the last valid version remains the head and the failed attempt becomes non-authoritative telemetry.
