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

Implemented a preparatory customer-managed key adapter without changing the merged envelope, lifecycle, rotation, revocation, access-audit, or break-glass contracts from pull request #578. This adapter is not production activation evidence on its own.

The adapter keeps key-encryption-key material outside Mendpoint. It sends only the existing tenant, provider, key, version, wrapped-key, and data-key fields through an injected HTTPS transport. Every external response is bound to the configured tenant, provider, key identifier, key version, customer-managed classification, attestation, and key-material fingerprint. The exact fingerprint is now also bound durably through a versioned attestation digest and the envelope's outer authenticated data. Every request requires an exact destination authority, a hard pre-network request-byte ceiling, and fresh validation of every resolved address.

## Artifacts

- `packages/platform/src/external-kek-client.ts`: bounded HTTPS transport with mandatory TLS, exact destination authority, public-address validation by default, explicit exact private-address authorization, DNS-rebinding and socket-reuse controls, pre-network request-size validation, timeout, response-size, redirect, exact JSON media-type, and redacted-error enforcement.
- `packages/platform/src/vault-envelope.ts`: `createExternalKeyEncryptionKeyProvider` factory and fail-closed external provider implementation using the unchanged `KeyEncryptionKeyProvider` interface.
- `packages/platform/src/index.ts`: public factory, client, configuration, and transport exports.
- `packages/platform/src/external-kek-client.test.ts`: denial, malformed-body, request and response overrun, timeout, abort settlement, HTTPS, request-shape, native all-address lookup, socket-reuse mutation, exact media-type, IPv4 and IPv6 address-class, private-authorization, and DNS-rebinding coverage.
- `packages/platform/src/vault-envelope.test.ts`: authority mutation, fingerprint-only restart drift, stale attestation, invalid data-key length, redaction, and full envelope seal-and-open coverage.

## Verification

- RED authority verification: ten direct-transport cases proved malformed identifiers, non-customer-managed keys, wrong-size data keys, and malformed or oversized wrapped material reached the authorized requester before validation.
- `node node_modules/vitest/vitest.mjs run --configLoader runner packages/platform/src/vault-envelope.test.ts packages/platform/src/external-kek-client.test.ts`: 79 tests passed.
- `node node_modules/vitest/vitest.mjs run --configLoader runner packages/platform/src`: 315 tests passed across 20 files with temporary test data directed to the isolated review directory.
- `npm run typecheck -w @mendpoint/platform`: passed.
- `npm run build`: optimized production build passed, including all 64 static pages.
- `git diff --check`: passed.

## Security and Compatibility

- HTTPS is mandatory; endpoint credentials, query strings, fragments, and redirects fail closed.
- The endpoint must match an explicit host-and-port authority. A scheme alone grants no destination authority.
- Public mode rejects loopback, unspecified, multicast, link-local, metadata, private, shared, documentation, benchmarking, and reserved IPv4 and IPv6 destinations.
- Private mode requires explicit operator authorization bound to the exact authority and exact private addresses; it cannot authorize loopback, metadata, link-local, multicast, or unspecified destinations.
- All resolved addresses are checked before every request, and the default HTTPS requester pins the socket lookup to one validated address for both scalar and Node all-address lookup callbacks so connection setup cannot perform a second, rebound DNS lookup.
- Native requests do not use the authority-keyed global socket pool, preventing a socket authorized by one address policy from being reused under a disjoint policy for the same hostname.
- Provider responses require the exact `application/json` media type, with parameters such as a valid charset accepted only after the media type is parsed exactly.
- Provider bodies, credentials, plaintext data keys, and wrapped bytes are never copied into errors.
- Serialized requests larger than 128 KiB are rejected before timeout setup, destination resolution, or requester invocation.
- Responses with the wrong provider, tenant, key identifier, key version, attestation, or key-material fingerprint are rejected.
- Customer-managed attestations require a canonical fingerprint and bind it into version 2 of the attestation authority. Previously persisted customer-managed envelopes without that binding fail closed; local and other non-customer-managed digests remain byte-compatible.
- Unwrapped data keys must decode canonically to exactly 32 bytes.
- Existing local and configured providers remain Mendpoint-custodied and retain their signatures and serialized formats.
- No purpose or request-digest guarantee was added to the provider interface.

## Commits and range-diff identity

- `3605c24b`: external customer-managed key adapter.
- `ea6b16a5`: initial verification evidence.
- `e46f4184`: exact destination authority and DNS-rebinding repair.
- `baf5a861`, `284d0df1`, and `8e659b51`: native lookup, socket isolation, streaming-overrun, and abort-settlement repairs.
- `663e7176` and `0e0aeb11`: fingerprint-drift and pre-network request-ceiling hostile tests and repair.
- `42a4ffb3` and `ef75b808`: direct public-transport input-boundary hostile tests and pre-network validation repair.

The exact current base for this rebased series is `8456b36ebe94a48560982d5265aedbfab30710e3`; the commands above verify the exact rebased pre-evidence head `e80c2ce24e0f0c8b8f6601e5ceb7cab4f09b5e6e`. `git range-diff f8d09056f713925baf585d99fc35aca79242108c..b5b70ff2568a883bf9419e21790f1871e6f685ef 8456b36ebe94a48560982d5265aedbfab30710e3..e80c2ce24e0f0c8b8f6601e5ceb7cab4f09b5e6e` maps all 15 commits one-to-one with no semantic delta. The independent exact-head PASS at `b5b70ff2568a883bf9419e21790f1871e6f685ef` is superseded by this history rewrite. A different reviewer must inspect and approve the final exact head before merge.

## Remaining Release Work

This preparatory adapter is implemented but not merged or deployed. `ME-ENT-003` remains incomplete. Plan 01-19 must bind the exact runtime configuration, and Plan 01-20 must prove server-to-service reachability and production behavior before the requirement can be qualified. The canonical branch also requires renewed exact-head independent review, current-base checks, protected continuous integration, normal merge, and production verification by the release owner.
