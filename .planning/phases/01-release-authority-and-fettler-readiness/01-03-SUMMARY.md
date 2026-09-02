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

The adapter keeps key-encryption-key material outside Mendpoint. It sends only the existing tenant, provider, key, version, wrapped-key, and data-key fields through an injected HTTPS transport. Every external response is bound to the configured tenant, provider, key identifier, key version, customer-managed classification, attestation, and key-material fingerprint. Every request also requires an exact destination authority and fresh validation of every resolved address.

## Artifacts

- `packages/platform/src/external-kek-client.ts`: bounded HTTPS transport with mandatory TLS, exact destination authority, public-address validation by default, explicit exact private-address authorization, DNS-rebinding and socket-reuse controls, timeout, response-size, redirect, exact JSON media-type, and redacted-error enforcement.
- `packages/platform/src/vault-envelope.ts`: `createExternalKeyEncryptionKeyProvider` factory and fail-closed external provider implementation using the unchanged `KeyEncryptionKeyProvider` interface.
- `packages/platform/src/index.ts`: public factory, client, configuration, and transport exports.
- `packages/platform/src/external-kek-client.test.ts`: denial, malformed-body, oversize-body, timeout, HTTPS, request-shape, native all-address lookup, socket-reuse mutation, exact media-type, IPv4 and IPv6 address-class, private-authorization, and DNS-rebinding coverage.
- `packages/platform/src/vault-envelope.test.ts`: authority mutation, stale attestation, invalid data-key length, redaction, and full envelope seal-and-open coverage.

## Verification

- `npm test -w @mendpoint/platform -- src/vault-envelope.test.ts src/external-kek-client.test.ts`: 65 tests passed.
- `npm test -w @mendpoint/platform`: 301 tests passed across 20 files.
- `npm run typecheck -w @mendpoint/platform`: passed.
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
- Responses with the wrong provider, tenant, key identifier, key version, attestation, or key-material fingerprint are rejected.
- Unwrapped data keys must decode canonically to exactly 32 bytes.
- Existing local and configured providers remain Mendpoint-custodied and retain their signatures and serialized formats.
- No purpose or request-digest guarantee was added to the provider interface.

## Commits and range-diff identity

- `9af8fad2`: external customer-managed key adapter, patch-identical to pre-rebase `0f4d7cbc`.
- `4caa5a70`: verification evidence, patch-identical to pre-rebase `a244286f`.
- `a5d8d387`: destination authority and DNS-rebinding repair, patch-identical to pre-rebase `649d0ae2`.
- `24a35019`: refreshed exact-head evidence after rebase.
- `775d80d7`: native all-address lookup compatibility repair.
- `e25bf527`: validated socket isolation repair.

The independent range-diff verified the first three old-to-new pairs as exact patch identities. The final three commits are additive repairs on the rebased series. The subsequent oversized-response settlement repair is the current review-fix commit and is verified by the commands above.

## Remaining Release Work

This preparatory adapter is implemented but not merged or deployed. `ME-ENT-003` remains incomplete. Plan 01-19 must bind the exact runtime configuration, and Plan 01-20 must prove server-to-service reachability and production behavior before the requirement can be qualified. The canonical branch also requires renewed exact-head independent review, current-base checks, protected continuous integration, normal merge, and production verification by the release owner.
