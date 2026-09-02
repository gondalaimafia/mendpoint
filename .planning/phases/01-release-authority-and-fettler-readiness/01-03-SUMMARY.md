---
phase: 01-release-authority-and-fettler-readiness
plan: "03"
status: implemented
issue: 604
branch: codex/604-fettler-cmk-gap-closure
requirements: [ME-ENT-003]
---

# Plan 01-03 Summary

## Outcome

Implemented a production-capable customer-managed key adapter without changing the merged envelope, lifecycle, rotation, revocation, access-audit, or break-glass contracts from pull request #578.

The adapter keeps key-encryption-key material outside Mendpoint. It sends only the existing tenant, provider, key, version, wrapped-key, and data-key fields through an injected HTTPS transport. Every external response is bound to the configured tenant, provider, key identifier, key version, customer-managed classification, attestation, and key-material fingerprint.

## Artifacts

- `packages/platform/src/external-kek-client.ts`: bounded HTTPS transport with mandatory TLS, timeout, response-size, redirect, content-type, and redacted-error enforcement.
- `packages/platform/src/vault-envelope.ts`: `createExternalKeyEncryptionKeyProvider` factory and fail-closed external provider implementation using the unchanged `KeyEncryptionKeyProvider` interface.
- `packages/platform/src/index.ts`: public factory, client, configuration, and transport exports.
- `packages/platform/src/external-kek-client.test.ts`: denial, malformed-body, oversize-body, timeout, HTTPS, and request-shape coverage.
- `packages/platform/src/vault-envelope.test.ts`: authority mutation, stale attestation, invalid data-key length, redaction, and full envelope seal-and-open coverage.

## Verification

- `npm test -w @mendpoint/platform -- src/vault-envelope.test.ts src/external-kek-client.test.ts`: 34 tests passed.
- `npm test -w @mendpoint/platform`: 270 tests passed across 20 files.
- `npm run typecheck -w @mendpoint/platform`: passed.
- `git diff --check`: passed.

## Security and Compatibility

- HTTPS is mandatory; endpoint credentials, query strings, fragments, and redirects fail closed.
- Provider bodies, credentials, plaintext data keys, and wrapped bytes are never copied into errors.
- Responses with the wrong provider, tenant, key identifier, key version, attestation, or key-material fingerprint are rejected.
- Unwrapped data keys must decode canonically to exactly 32 bytes.
- Existing local and configured providers remain Mendpoint-custodied and retain their signatures and serialized formats.
- No purpose or request-digest guarantee was added to the provider interface.

## Commits

- `36e25360`: implementation and tests.

## Remaining Release Work

This plan is implemented but not merged or deployed. The canonical branch still requires exact-head independent review, current-base checks, protected continuous integration, normal merge, and production verification by the release owner.
