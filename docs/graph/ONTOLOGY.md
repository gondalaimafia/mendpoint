# Change Graph ontology v1

## Scope

Every tenant-owned fact binds `tenantId`, `repositoryId`, `repositorySnapshotId`, `repositoryRevision`, and `graphVersionId`. Shared provider facts bind `providerId`, `providerSnapshotId`, and `providerRevision`. A cross-scope edge is valid only when its evidence names both authoritative snapshots.

## First Fettler entity kinds

| Kind | Canonical identity |
|---|---|
| Provider | provider authority ID |
| Endpoint | provider snapshot, protocol, method, normalized path or operation ID |
| ProviderSdkMethod | provider snapshot, SDK package, version, exported method path |
| InternalSdkMethod | repository snapshot, file, qualified symbol |
| Function | repository snapshot, file, qualified symbol |
| Test | repository snapshot, file, qualified test symbol |

## First relationship kinds

| Relationship | Meaning |
|---|---|
| USES_ENDPOINT | provider SDK method calls or implements an endpoint |
| USES_SDK_METHOD | internal SDK method calls a provider SDK method |
| WRAPS | a function wraps an SDK method or another function |
| CALLS | caller invokes callee |
| TESTS | a test exercises a function or method |

The first required path is `Test -> TESTS -> Function -> WRAPS or CALLS -> InternalSdkMethod -> USES_SDK_METHOD -> ProviderSdkMethod -> USES_ENDPOINT -> Endpoint`. Traversal may return the reverse presentation from Endpoint to Test, but stored edge direction remains semantic.

## Resolution outcomes

- `exact`: one canonical key matched.
- `alias`: one explicitly versioned alias matched.
- `ambiguous`: more than one admissible entity matched.
- `unresolved`: no admissible entity matched.
- `collision`: one canonical key maps to incompatible identities or snapshots.

Only exact and alias results may create active relationships. Ambiguous, unresolved, and collision results remain evidence and reduce coverage.
