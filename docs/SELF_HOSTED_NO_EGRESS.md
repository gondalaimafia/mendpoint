# Self-hosted no-egress model mode

Mendpoint sends repository content to a model provider as the chat-completions
prompt. In a self-hosted deployment you may need to guarantee that this content
never leaves your environment. The `MENDPOINT_MODEL_EGRESS=local_only` mode
enforces that guarantee at the application layer, where the model endpoint is
resolved.

## Configuration

| Variable | Values | Default | Meaning |
| --- | --- | --- | --- |
| `MENDPOINT_MODEL_EGRESS` | `local_only`, `external_allowed` | `external_allowed` | `local_only` restricts model calls to private hosts. The default preserves current behavior. |
| `MENDPOINT_MODEL_LOCAL_HOSTS` | comma or space separated hostnames | empty | Operator allowlist of private hostnames (for example `localhost,model.internal`) that pass the local check even when they are not IP literals. |
| `LLM_AGENT_URL` (or `OPENAI_BASE_URL`) | URL | unset | The model endpoint. When unset under `local_only`, the agent runs on its deterministic heuristics only and makes no model call. |

A host counts as local when it is any of:

- Loopback: `127.0.0.0/8`, `::1`
- Private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local: `169.254.0.0/16`, `fe80::/10`
- Unique local IPv6: `fc00::/7`
- The names `localhost`, `*.local`, `*.localhost`
- Any host listed in `MENDPOINT_MODEL_LOCAL_HOSTS`

A public host such as `api.meta.ai` is rejected.

## What it guarantees

- Repository content sent as a model prompt can only reach a private, loopback,
  link-local, or explicitly allowlisted host. A configured public model
  endpoint is rejected before any call is made.
- The check runs at two points, so a misconfiguration fails fast rather than at
  first agent run:
  - Boot validation (`validateApiEnv`, and the customer Gauge profile
    validator) rejects a `local_only` deployment whose `LLM_AGENT_URL` resolves
    to a public host, or an invalid `MENDPOINT_MODEL_EGRESS` value.
  - Resolve time (`resolveAgentModelEndpoint`) throws
    `model_egress_local_only_violation` before returning a non-local endpoint.

## What it does NOT guarantee

- This is the application-layer model-egress control only. It governs the model
  endpoint the agent resolves and calls. It does not by itself isolate the
  host's network, block other outbound connections, or replace an
  infrastructure network policy. Pair it with your platform network policy (for
  example a Fly network policy, firewall, or egress proxy) for full isolation.
- It does not change the default model provider or the default data flow.
  `external_allowed` remains the default; `local_only` is an explicit opt-in.

## How to verify

1. Read the readiness output (`readiness()` / `/readyz`). The `modelEgress`
   field reports the active mode and whether the local-only guarantee currently
   holds:

   ```json
   {
     "modelEgress": {
       "mode": "local_only",
       "localOnly": true,
       "endpointConfigured": true,
       "localOnlySatisfied": true
     }
   }
   ```

   The `checks` array also includes a `model_egress` entry that turns the probe
   status to `fail` on a violation.

2. Confirm that a public model endpoint is rejected at boot. With
   `MENDPOINT_MODEL_EGRESS=local_only` and `LLM_AGENT_URL=https://api.meta.ai/v1`,
   startup validation fails with a message stating that `local_only` forbids an
   external model endpoint.
