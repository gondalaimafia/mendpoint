# Model router

Select a policy-eligible deterministic recipe, adapter, local model, open model, or frontier provider for each structured task.

Status: Runtime component
Availability: Used by specialist runtimes; configured providers and executors vary by deployment
Last verified: 2026-08-14
Requirements: ME-RTR-001, ME-RTR-002, ME-RTR-003, ME-RTR-004, ME-RTR-005, ME-RTR-006, ME-RTR-009
Public claims: None

## Start here

Register only approved executors, then route a structured task under tenant risk, data, region, quality, latency, and budget policy.

1. Create an executor registry with immutable descriptors.
2. Define the tenant task and routing policy.
3. Resolve the ranked eligible candidates.
4. Dispatch through the selected executor and return the immutable routing decision, cost, and outcome.

## What it does

- Eligibility filtering by tenant, capability, tool, region, data classification, risk, cost, latency, and health
- Deterministic ranking with recipe preference when requirements match
- Circuit breakers, bounded retries, policy-bound fallback, and human handoff
- OpenAI, Anthropic, Gemini, xAI, Muse Spark, and OpenAI-compatible provider adapters
- Immutable per-decision routing and provider provenance record

## When to use it

- A specialist workflow needs model or recipe selection under policy.
- A tenant needs region, privacy, cost, or risk constraints.
- A provider failure should fall back only to another explicitly authorized executor.

## How it works

1. The caller submits a structured task spec rather than a free-form provider choice.
2. The router removes ineligible or unhealthy executors.
3. It ranks remaining candidates deterministically using configured utility and limits.
4. The runtime dispatches through the chosen adapter, accounts usage, and returns the immutable decision record.
5. Fresh policy and lifecycle checks run again at sensitive dispatch boundaries.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| Router task spec | Artifact | Tenant, capabilities, tools, region, data class, risk, quality, latency, and budget. |
| Executor descriptor | Artifact | Kind, identity, capabilities, price, limits, health, and policy metadata. |
| Router dispatch | Artifact | Selected executor and immutable decision evidence. |
| Provider registry | Configuration | Enabled providers, endpoints, credentials, prices, and model policies. |

## Evidence and verification

- Router policy and ranking: `packages/platform/src/router.test.ts`
- Model provider adapters: `packages/agent/src/model-providers.test.ts`

## Contract sources

- `packages/platform/src/router.ts`
- `packages/platform/src/router-runtime.ts`
- `apps/worker/src/cli.ts`

## Safety model

- Callers cannot bypass tenant, risk, region, tool, or data-classification policy.
- Fallback never broadens authority.
- Provider credentials are not serialized into routing evidence.
- Spend is reserved and settled through the runtime accounting boundary.

## Limitations

- The repository does not commit a universal production executor registry; availability depends on deployment secrets and approvals.
- Quality scores and prices are configuration evidence, not independent guarantees.
- The router selects and authorizes execution; it is not itself a model.

## See also

- [Post-trained models](./post-trained-models.md)
- [Learning system](./learning-system.md)
- [Billing and usage](./billing-usage.md)
- [Fettler — the first AI API Engineer](./fettler.md)
