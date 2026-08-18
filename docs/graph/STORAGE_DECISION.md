# Change Graph storage decision

SQLite remains the first authoritative store.

Version manifests and canonical graph payloads are append-only. Publication builds and validates a complete successor inside a transaction, inserts immutable content, then advances a tenant, repository, and provider head with compare-and-set semantics. Failure leaves the prior head unchanged. Missions read an exact version, never an implicit mutable head after dispatch.

The existing `gl_nodes` and `gl_edges` v0 tables remain compatible during migration. New v1 tables do not rewrite historical identifiers. Operational tables remain relational authorities; the graph stores relationships and their evidence.

A native graph database will be considered only after benchmark evidence shows SQLite cannot meet bounded traversal, publication, or storage targets. Migration must preserve canonical IDs, version digests, evidence references, and historical reads.
