# Webhooks and domain events

Accept authenticated SCM events, deduplicate deliveries, derive tenant scope from durable bindings, and record replay safe domain outcomes.

Status: GitHub production path
Availability: GitHub webhook ingestion is implemented; a customer ready GitLab webhook path is not active
Last verified: 2026-08-30
Publication evidence: not live; no deployed revision or live evidence digest recorded
Requirements: ME-SCM-003, ME-SCM-004, ME-WAR-004, ME-WAR-008
Public claims: None

## Start here

Configure the GitHub App webhook to the public callback and subscribe only to events required by enabled capabilities.

1. Set the webhook URL to https://your-mendpoint.example/webhooks/github.
2. Store the webhook secret in the protected deployment environment.
3. Select pull request, pull request review, check, installation, and repository events required by the installation.
4. Send a test event and verify one durable delivery record and one resulting domain transition.

## What it does

- GitHub signature verification
- Delivery identity deduplication
- Installation and repository authority resolution
- Pull request, review, check, installation, and repository reconciliation
- Outcome learning dispatch after durable delivery state

## When to use it

- GitHub must update repository authority or pull request state.
- A response can be lost and the provider may redeliver the same event.

## How it works

1. The public endpoint verifies the signature before reading event authority.
2. The delivery ID is claimed once and duplicate deliveries adopt the retained result.
3. Installation and repository identifiers resolve one authorized tenant binding.
4. The handler commits domain state before dispatching follow up work.
5. Provider comments and review text remain untrusted evidence and never authorize mutation by themselves.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| POST /webhooks/github | API | Receive a signed GitHub App delivery. |
| Webhook delivery | Event | Signature, provider delivery ID, event kind, state, and retained outcome. |
| Domain event | Event | Tenant scoped idempotent product transition derived from verified provider evidence. |

## Evidence and verification

- Webhook route: `apps/api/src/server.ts`
- Fettler review dispatch: `apps/api/src/fettler-pr-review-webhook.test.ts`
- Connection round trip: `apps/api/src/repository-connect.test.ts`
- Outcome deduplication: `apps/api/src/delivery-outcome-learning-dispatch.test.ts`

## Contract sources

- `apps/api/src/server.ts`
- `apps/api/src/fettler-pr-review-webhook.ts`
- `apps/api/src/delivery-outcome-learning-dispatch.ts`

## Safety model

- Unsigned, stale, malformed, or unauthorized deliveries fail closed.
- The request body tenant is never trusted.
- Duplicate delivery is not duplicate work.
- Webhook evidence cannot merge, deploy, or widen candidate authority.

## Limitations

- GitLab delivery is on the roadmap.
- Enabled event types depend on the installed GitHub App permissions and product profile.

## See also

- [Repository connections](./repository-connections.md)
- [Draft delivery](./draft-delivery.md)
- [API conventions](./api-conventions.md)
- [Audit and compliance evidence](./audit-compliance.md)
