# Multi-provider model gateway

The Warden agent routes its live model calls through a provider-registry gateway.
The active backend is one of several **named providers**, selected by
configuration. Each provider declares its endpoint source, auth source, native
wire format, transport class, and a per-provider price table. This is the
concrete implementation behind the claim: *multi-model LLM orchestration routing
across multiple providers via a gateway pattern.*

The design is **additive and default-preserving**: with the selector unset the
gateway resolves exactly the prior single OpenAI-compatible backend, so existing
behavior is unchanged.

## Selecting a provider

Set `MENDPOINT_MODEL_PROVIDER` to a registered provider id. When it is **unset**,
the gateway uses the legacy default path — `resolveAgentModelEndpoint()`
(`LLM_AGENT_URL` / `OPENAI_BASE_URL`) with `OPENAI_API_KEY ?? XAI_API_KEY` and the
`muse-spark` price table — byte-for-byte as before.

The transmitted model id is `LLM_AGENT_MODEL` when set, otherwise the provider's
`defaultModel`.

An **unknown** provider id fails closed (`warden_model_provider_unknown`); the
gateway never silently falls back to the default.

## Registered providers

| id | wire format | transport | endpoint (base) | auth env (first match) | default model | priced |
|----|-------------|-----------|-----------------|------------------------|---------------|--------|
| `muse-spark` | openai | native | `LLM_AGENT_URL` / `OPENAI_BASE_URL` | `OPENAI_API_KEY`, `XAI_API_KEY` | `muse-spark-1.2-contributor` | yes (deployment rates) |
| `openai` | openai | native | `OPENAI_BASE_URL` or `https://api.openai.com` | `OPENAI_API_KEY` | `gpt-4o-mini` | reference list prices |
| `xai` | openai | native | `XAI_BASE_URL` or `https://api.x.ai` | `XAI_API_KEY` | `grok-2-latest` | reference list prices |
| `openai-gateway` | openai | **gateway** | `LLM_AGENT_URL` / `OPENAI_BASE_URL` (required) | `OPENAI_API_KEY`, `XAI_API_KEY` | `gpt-4o-mini` | no (operator-configured) |
| `anthropic` | anthropic | native | `ANTHROPIC_BASE_URL` or `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-latest` | reference list prices |
| `gemini` | gemini | native | `GEMINI_BASE_URL` or `https://generativelanguage.googleapis.com` | `GOOGLE_GEMINI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `gemini-1.5-flash` | reference list prices |

## Native wire format vs gateway-fronted — read this before making claims

This is the honest boundary of what is built. Do not overstate it.

- **Native OpenAI-compatible wire format:** `muse-spark`, `openai`, `xai`, and
  `openai-gateway`. These speak the OpenAI `/chat/completions` request/response
  shape directly, including OpenAI's strict `json_schema` structured-output
  validator. The request/response code path is unchanged from the single-provider
  implementation.

- **Native non-OpenAI wire formats, via adapters:** `anthropic` speaks the
  **Anthropic Messages API** (`/v1/messages`) and `gemini` speaks the **Google
  Gemini generateContent API** (`/v1beta/models/{model}:generateContent`). These
  are genuinely native — the gateway builds each vendor's own request body and
  parses each vendor's own response — through thin translation adapters
  (`model-adapters.ts`). They are wired end-to-end in the agent loop and covered
  by unit tests plus a mock-server integration test.

  **Caveat, stated plainly:** the Anthropic and Gemini adapters request JSON
  output through each vendor's own mechanism (Anthropic: prompt-guided JSON in the
  system turn; Gemini: `responseMimeType: "application/json"`), **not** OpenAI's
  strict `json_schema` validator, which is an OpenAI-family feature. The tool-call
  contract is otherwise identical.

- **Gateway-fronted:** `openai-gateway` is explicitly an OpenAI-compatible proxy
  or self-hosted endpoint. It can front an arbitrary upstream model behind the
  OpenAI wire format. Use this for any provider you reach through an
  OpenAI-compatible gateway rather than a native adapter.

## Pricing and cost attribution

Cost is attributed per **provider + model**. Each provider carries its own price
table keyed by exact model id; `buildLiveModelProvenance` is given the active
provider's table and stamps the provenance record with `providerId`.

Pricing is honest: a model absent from its provider's table resolves to a **null**
cost — never a guessed one. The vendor providers ship with **reference list
prices** known at authoring time; operators should verify these and override per
model as vendor pricing changes. The `openai-gateway` provider ships **unpriced**
because it can front any upstream — the operator must configure the fronted
model's rate.

Note the safety consequence: the run-time usage gate requires a positive measured
cost, so an **unpriced** model fails closed at that gate until its rate is
configured. Resolving a provider (endpoint/auth/wire) is separate from being able
to complete a live, cost-attributed call.

## Policy router compatibility

The provider gateway selects *which model backend* a run uses. It is independent
of the policy router (`routed-agent.ts`), which selects *which executor* handles a
run. Both remain in force; provider selection does not change executor routing.
