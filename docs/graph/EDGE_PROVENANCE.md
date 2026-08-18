# Change Graph fact provenance

Every v1 entity and relationship carries:

- a deterministic canonical fact ID that remains stable when the fact's evidence-bearing attributes change;
- entity kind or relationship kind and schema version;
- tenant or governed shared-provider scope;
- repository and provider snapshot bindings where applicable;
- extractor ID, version, and digest;
- one or more immutable evidence references;
- confidence plus deterministic confidence basis;
- `validFrom` and optional `validTo`;
- `active`, `stale`, `conflicted`, or `superseded` status;
- conflict references when sources disagree.

Relationships additionally bind their source and target canonical entity IDs. Every coverage stage separately binds its extractor identity, deterministic basis, analyzed and omitted counts, immutable evidence, and explicit omission reasons. Coverage is never inferred from the mere presence of facts.

Evidence may originate from AST, import resolution, provider specification, package metadata, call graph, tests, runtime traces, or an approved human assertion. Model output alone cannot create an active executable relationship. Model suggestions require deterministic or human grounding before publication.

Canonical serialization uses UTF-8 JSON, sorted object keys, code-unit array ordering where order is not semantic, and SHA-256. Locale-dependent comparison is forbidden.
The complete immutable graph version is content-addressed. Stable fact IDs make version diffs able to distinguish changed facts from additions and removals.
