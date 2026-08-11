# SAML 2.0 Single Sign-On

Mendpoint supports SAML 2.0 SP-initiated single sign-on as an alternative to
OIDC for enterprise identity providers (Okta, Azure AD / Entra ID, Ping, and
others). A SAML login produces the same authenticated human web session, bound
to the same tenant membership, as an OIDC login. Human review authorization and
everything downstream behaves identically for a SAML-authenticated human.

SAML is env gated and default off. When the SAML environment variables are
absent, nothing changes: the SAML routes report `saml_not_configured`, and OIDC
and every other auth path behave exactly as before.

## What is supported

- SP-initiated SSO (the browser starts at `/api/saml/start`, is redirected to
  the IdP, and returns via HTTP-POST to the ACS).
- HTTP-Redirect binding for the outgoing AuthnRequest.
- HTTP-POST binding for the inbound SAML Response.
- XML signature verification of the assertion against the configured IdP X.509
  certificate (RSA-SHA256).
- The following validations, all fail-closed:
  - Signature over the assertion. Unsigned or wrongly signed assertions are
    rejected (`wantAssertionsSigned` is always on).
  - AudienceRestriction equals the configured SP entity ID.
  - SubjectConfirmationData `Recipient` equals the configured ACS URL. This is
    inside the signed assertion, so it is authoritative. The SP enforces it
    directly because node-saml does not.
  - Conditions `NotBefore` / `NotOnOrAfter` and SubjectConfirmationData
    `NotOnOrAfter` time windows, with a configurable clock skew.
  - `InResponseTo` correlation. The AuthnRequest ID is stored in an encrypted,
    HttpOnly flow cookie and the inbound `InResponseTo` must match it.
  - `RelayState` correlation against the same encrypted flow cookie.
  - Single-use assertion ID replay protection.
- SP metadata at `/api/saml/metadata` for IdP configuration.

## What is NOT supported

- IdP-initiated SSO. Only SP-initiated flows are accepted. An unsolicited
  Response has no matching `InResponseTo` in the flow cookie and is rejected.
- Encrypted assertions (`EncryptedAssertion`). The IdP must send a signed,
  cleartext assertion. Configure the IdP to sign the assertion and not encrypt
  it.
- Single Logout (SLO).
- SCIM / automated user provisioning. Tenant memberships are provisioned
  through the existing `/tenants/memberships` API. A user must already have an
  active membership keyed by `(bridge issuer, NameID)` to be authorized.
- Multiple IdPs against one deployment simultaneously. SAML is an alternative to
  OIDC; configure the API to trust one issuer (see below).
- The single-use replay guard is in-memory and per instance. A horizontally
  scaled deployment must back it with a shared store; this build documents the
  limitation rather than hiding it.

## How a SAML login becomes a tenant-bound human session

The API authorizes humans by verifying a bearer JWT through its existing OIDC
verifier: it checks the signature against a JWKS, checks issuer / audience /
tenant claim / MFA, looks up the tenant membership by `(issuer, subject)`, and
sets a human principal. That is the only path that yields `isHumanWardenReviewer`
= true.

To make a SAML human authenticate through that same path unchanged, the SP
bridges SAML to a short-lived signed JWT:

1. `/api/saml/acs` validates the SAML Response (all checks above).
2. It extracts the subject (NameID), email, and tenant. The tenant comes from a
   SAML attribute (`SAML_TENANT_ATTRIBUTE`, default `tenantId`) or, if absent,
   from `SAML_DEFAULT_TENANT_ID`. If neither yields a tenant, the login fails.
3. It mints an RS256 JWT whose `iss`, `aud`, tenant claim, `sub`, and `amr` are
   aligned with the API's OIDC verifier configuration, signed with the bridge
   key.
4. It stores that JWT as the upstream bearer inside the same encrypted
   `human_oidc` web session the OIDC callback creates. Downstream, the web proxy
   forwards it as `Authorization: Bearer <jwt>` exactly as for OIDC.
5. The API verifies it via `OIDC_JWKS_URI` (which points at `/api/saml/jwks`),
   maps `(issuer, subject)` to the tenant membership, and authorizes the human.

The bridge issuer is the identity the tenant membership must be provisioned
against. Provision memberships with `issuer = SAML_JWT_ISSUER` and
`subject = NameID`.

## Environment configuration

SAML is active only when all of the SP fields and all of the bridge fields are
set.

SP (assertion validation):

| Variable | Required | Description |
| --- | --- | --- |
| `SAML_IDP_SSO_URL` | yes | IdP SSO endpoint (https). AuthnRequests are sent here. |
| `SAML_IDP_CERT` | yes | IdP signing certificate (PEM or base64 DER). |
| `SAML_IDP_ENTITY_ID` | no | IdP entity ID. Validates the Response Issuer when set. |
| `SAML_SP_ENTITY_ID` | yes | SP entity ID. Also the expected assertion Audience. |
| `SAML_ACS_URL` | yes | SP Assertion Consumer Service URL. Expected Recipient. |
| `SAML_SP_PRIVATE_KEY` | no | SP key (PKCS8 PEM). Signs the AuthnRequest when set. |
| `SAML_WANT_RESPONSE_SIGNED` | no | Require the top-level Response to be signed too. |
| `SAML_CLOCK_SKEW_MS` | no | Accepted clock skew in ms (default 5000). |
| `SAML_MAX_ASSERTION_AGE_MS` | no | Max assertion age in ms (0 disables). |
| `SAML_AUTHN_CONTEXT` | no | Requested AuthnContextClassRef(s), comma separated. |
| `SAML_TENANT_ATTRIBUTE` | no | Assertion attribute carrying the tenant (default `tenantId`). |
| `SAML_DEFAULT_TENANT_ID` | no | Fallback tenant when the assertion omits one. |

Bridge (JWT the API verifies):

| Variable | Required | Description |
| --- | --- | --- |
| `SAML_JWT_ISSUER` | yes | Bridge issuer (https). Must equal the API's `OIDC_ISSUER`. |
| `SAML_JWT_AUDIENCE` | yes | Must equal the API's `OIDC_AUDIENCE`. |
| `SAML_JWT_SIGNING_KEY` | yes | RS256 private key (PKCS8 PEM). |
| `SAML_JWT_KID` | yes | Key ID published in the JWKS. |
| `SAML_JWT_TENANT_CLAIM` | no | Tenant claim name (default `tenant_id`). Must equal the API's `OIDC_TENANT_CLAIM`. |
| `SAML_JWT_AMR` | no | `amr` values set on the JWT (default `mfa`). Must satisfy the API's `OIDC_REQUIRED_AMR` / `OIDC_ALLOWED_ACR`. |
| `SAML_SESSION_MAX_AGE_SECONDS` | no | Session lifetime, capped at 3600. |

On the API side, point the existing OIDC verifier at the bridge:

```
OIDC_ISSUER=<SAML_JWT_ISSUER>
OIDC_AUDIENCE=<SAML_JWT_AUDIENCE>
OIDC_JWKS_URI=https://<web-host>/api/saml/jwks
OIDC_TENANT_CLAIM=<SAML_JWT_TENANT_CLAIM>
OIDC_REQUIRED_AMR=mfa   # or align OIDC_ALLOWED_ACR with the IdP AuthnContext
```

## Setup steps

1. Generate the bridge signing key and set `SAML_JWT_SIGNING_KEY` /
   `SAML_JWT_KID`. Choose `SAML_JWT_ISSUER` and `SAML_JWT_AUDIENCE`.
2. Configure the API's OIDC verifier to trust the bridge (table above). The
   API's OIDC code is unchanged; only its configuration points at the bridge.
3. Set the SP fields. Retrieve SP metadata from `/api/saml/metadata` and hand it
   to the IdP, or configure the IdP with the SP entity ID and ACS URL directly.
4. In the IdP, create the app, set the ACS URL (`SAML_ACS_URL`), the audience
   (`SAML_SP_ENTITY_ID`), sign the assertion (not encrypted), and release a
   tenant attribute (`SAML_TENANT_ATTRIBUTE`) plus email.
5. Provision a tenant membership for each user with
   `issuer = SAML_JWT_ISSUER`, `subject = NameID`, and the desired role.
6. Users sign in at `/access` with "Sign in with SAML SSO".

## Security notes

- XML signature verification uses `@node-saml/node-saml`, which layers XML
  signature wrapping defenses on top of `xml-crypto`. XML-DSig is not hand
  rolled.
- The flow cookie is AES-GCM encrypted and HttpOnly, keyed off
  `MENDPOINT_WEB_ACCESS_TOKEN`, with a 10 minute lifetime. It is set
  `SameSite=None; Secure` in production because the ACS receives a cross-site
  top-level POST from the IdP.
- The JWKS endpoint serves only public key components. Private key material is
  never exposed.
- Every validation fails closed. A missing subject, missing tenant,
  unresolvable assertion ID, mismatched Recipient / Audience / InResponseTo /
  RelayState, or an expired or unsigned assertion all reject the login.
