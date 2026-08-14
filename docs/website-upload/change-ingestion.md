# Change ingestion

Normalize versioned API and release evidence into deterministic changes with explicit compatibility classifications.

Status: Mixed availability
Availability: OpenAPI active; GraphQL and several release sources are gated previews
Last verified: 2026-08-14

## Start here

Submit a versioned provider schema or poll an approved feed, then inspect the normalized change set.

1. Create or select a provider.
2. Publish a versioned OpenAPI document or configure an approved feed.
3. Run detection for the monitored consumer.
4. Review breaking, non-breaking, and new-capability findings before fanout.

## What it does

- OpenAPI JSON structural normalization and diffing
- GraphQL SDL and introspection normalization with canonical digests
- Breaking, dangerous, non-breaking, and additive classification with migration hints
- npm SDK release probes and compatibility signals
- RSS, Atom, GitHub Releases, provider-page, and registry document adapters as tested library components
- Manual provider announcements and redacted incident evidence

## When to use it

- A provider publishes a new schema or SDK release.
- A team needs exact compatibility evidence before impact analysis.
- A manual announcement or incident must enter the same review trail.

## How it works

1. Source bytes are bounded, normalized, and content addressed.
2. The selected baseline and new version are compared structurally rather than by prose alone.
3. Each change receives a stable identity, severity, location, and migration hint.
4. Reviewed changes can fan out into graph impact and Fettler planning.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| POST /providers/:slug/versions | API | Store a versioned provider schema. |
| POST /providers/:slug/publish-version | API | Publish and classify a version. |
| POST /feeds/poll | API | Poll configured feeds. |
| POST /graphql/schemas | API | Store and diff GraphQL SDL or introspection when enabled. |
| POST /change-sources | API | Submit reviewed manual change evidence when enabled. |

## Evidence and verification

- OpenAPI normalization and diff: `packages/change-intel/src/index.test.ts`
- GraphQL normalization and diff: `packages/change-intel/src/graphql-schema.test.ts`
- Catalog polling: `packages/catalog/src/poll.test.ts`

## Safety model

- Tenant and source identity are derived from authenticated authority, not request claims.
- Immutable version labels reject changed-content replay.
- Oversized, malformed, contradictory, or cross-tenant evidence fails closed.

## Limitations

- GraphQL ingestion is gated by MENDPOINT_GRAPHQL_INGESTION_ENABLED.
- PyPI is declared as a signal type but no live PyPI probe is implemented.
- General changelog ingestion adapters are tested library code; continuous production use is not implied.

## See also

- [Fettler — the first AI API Engineer](./fettler.md)
- [Change Graph](./change-graph.md)
- [Repository connections](./repository-connections.md)
