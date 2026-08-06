# Sandbox verifier

Warden / repair verification runs candidate commands to decide whether a repair
is green. Historically that ran under a Node permission verifier on the worker
host (`packages/repair/src/verify.ts`) — a permission model, not a real tenant
boundary. This module adds a `SandboxVerifier` seam with a Fly Machines backend
that runs each verification inside a dedicated, ephemeral, tenant-isolated
machine.

Source: `packages/repair/src/sandbox.ts`. Tests:
`packages/repair/src/sandbox.test.ts` (mock Machines API — no real Fly calls).

## Backends

| Backend        | Default | Isolation                                                                 |
| -------------- | ------- | ------------------------------------------------------------------------- |
| `local`        | yes     | None beyond the existing Node permission verifier on the worker host.     |
| `fly_machines` | no      | One ephemeral Fly Machine per verification in a dedicated Fly app.         |

The `local` backend delegates to `runVerificationCommand` and is unchanged. It
remains the default so nothing changes until `fly_machines` is explicitly
selected.

## Configuration

Read by `resolveSandboxConfig(env)`. All numeric values are clamped to
fail-closed ceilings.

| Env var                                | Default                         | Meaning                                              |
| -------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| `MENDPOINT_SANDBOX_BACKEND`            | `local`                         | `local` or `fly_machines`.                           |
| `MENDPOINT_SANDBOX_FLY_TOKEN`          | (none)                          | Deploy-scoped token for the sandbox app. Required.   |
| `MENDPOINT_SANDBOX_APP`                | `mendpoint-sandbox`             | Dedicated Fly app (isolated from production).        |
| `MENDPOINT_SANDBOX_API_BASE`           | `https://api.machines.dev/v1`   | Machines REST API base, including the `/v1` segment. |
| `MENDPOINT_SANDBOX_IMAGE`              | `node:22`                       | Guest OCI image.                                     |
| `MENDPOINT_SANDBOX_CPUS`               | `1` (max 8)                     | Guest shared CPUs.                                   |
| `MENDPOINT_SANDBOX_MEMORY_MB`          | `512` (256–8192)                | Guest memory.                                        |
| `MENDPOINT_SANDBOX_TIMEOUT_MS`         | `300000` (max 900000)           | Hard wall-clock ceiling per verification.            |
| `MENDPOINT_SANDBOX_EXEC_TIMEOUT_MS`    | `300000`                        | Per-exec ceiling in ms (clamped to remaining wall clock, converted to whole seconds for the request, then clamped to Fly's ~60s server ceiling). |
| `MENDPOINT_SANDBOX_API_TIMEOUT_MS`     | `30000` (max 120000)            | Per-API-call ceiling.                                |
| `MENDPOINT_SANDBOX_WORKSPACE_MAX_BYTES`| `67108864` (64 MB, max 256 MB)  | Packed workspace tarball cap.                        |
| `MENDPOINT_SANDBOX_OUTPUT_CAP_BYTES`   | `262144` (256 KB)               | stdout/stderr capture cap.                           |
| `MENDPOINT_SANDBOX_MAX_API_RETRIES`    | `4` (max 8)                     | Bounded retries on 429/5xx/network errors.           |

The deploy token stays in the `Authorization` header. It is **never** placed in
the guest env. `MENDPOINT_SANDBOX_FLY_TOKEN` is stored as a secret on the
production app and reaches the worker as an env var.

## Lifecycle

Per verification, `FlyMachinesSandbox.verify`:

1. Validates the command against the supported verification profiles
   (`parseVerificationCommand`). Unsupported commands fail closed before any API
   call.
2. Packs the candidate workspace into a gzipped `ustar` tarball, base64-encoded
   (`packWorkspaceTarGz`). Self-contained — no host `tar` dependency. Excludes
   `.git`, `node_modules`, `dist`, `.next`, `coverage`, `.turbo`, `.cache`;
   skips symlinks; enforces the byte cap.
3. Creates an ephemeral machine (`restart.policy = "no"`, `auto_destroy = true`,
   bounded guest, no `services`), uploading the tarball via the create payload's
   `files` mechanism (the simplest reliable path — no exec base64-chunking).
4. Waits for `started`, bounded by the remaining wall clock.
5. Execs `/bin/sh -lc "mkdir … && tar -xzf … && cd … && <verifier>"` with a hard
   timeout, capturing bounded stdout/stderr and the exit code.
6. **Always** force-destroys the machine in a `finally` block, with bounded
   retries. A `404` counts as confirmed gone. A machine that cannot be confirmed
   destroyed fails the verification with `sandbox_machine_not_destroyed` and
   `reconciliationRequired: true`, regardless of whether the verifier passed.

### Exec payload shape and the server-side timeout ceiling

The exec request matches the live Machines API exactly:

```json
{ "command": ["/bin/sh", "-lc", "<pipeline>"], "timeout": 60 }
```

- The field is `command` (an argv array), **not** `cmd`.
- `timeout` is in **whole seconds**, not milliseconds. The config surface stays in
  milliseconds (`MENDPOINT_SANDBOX_EXEC_TIMEOUT_MS`); `execVerifier` converts to
  seconds with `Math.ceil` and guards the zero case (minimum 1 second).
- Fly's exec endpoint enforces a documented server-side ceiling of roughly **60
  seconds** (`SERVER_EXEC_CEILING_SECONDS`). A larger `timeout` is not honored, and
  a command that runs past it returns a deadline-exceeded error. We therefore clamp
  the requested seconds down to the ceiling before sending, and log a structured
  `sandbox_exec_timeout_clamped` note when the clamp applies. Because the default
  exec timeout (300s) exceeds the ceiling, the clamp is the normal case: the
  effective per-exec limit is the 60s ceiling regardless of a higher configured
  value.
- A provider deadline-exceeded exec response (HTTP `504`, or a `deadline` marker in
  the response body) maps to the `sandbox_timeout` error code — the same
  exec-timeout path as a client-side abort — rather than a generic
  `sandbox_exec_failed`.

## Boundaries enforced vs residual risks

| Boundary            | Status in this slice                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| Process isolation   | Enforced — separate machine per verification.                                        |
| Filesystem          | Enforced — only the packed workspace is shipped; no host volumes mounted.            |
| Secrets             | Enforced — explicit minimal guest env `{MENDPOINT_SANDBOX_RUN, CI}`; nothing from `process.env`; token stays in the auth header. |
| App / network scope | Enforced — dedicated `mendpoint-sandbox` app; no access to the production app's network, volumes, or secrets. |
| CPU / memory        | Enforced — bounded guest with clamped ceilings.                                      |
| Time                | Enforced — hard wall-clock cap plus a guaranteed force-destroy.                      |
| Inbound network     | Enforced — no `services` declared; the machine exposes no inbound surface.           |
| **Outbound network**| **NOT enforced (residual risk).** Fly Machines get outbound internet by default and the public Machines REST API cannot disable it via machine config alone. This slice does not claim default-deny egress. |

Do not describe this sandbox as "default-deny network" in any user-facing string
until an egress-blocking mechanism ships.

## Orphan reconciliation

`sweepOrphanedSandboxMachines(config, { graceMs, now }, deps)` lists machines in
the sandbox app, force-destroys those older than the grace period (default 15
min), and reports failures. It is exported for a future worker maintenance loop
and is intentionally **not** wired into `apps/worker` in this slice to avoid
conflicts with parallel sessions.

## Follow-ups

- **Egress blocking.** Add an outbound-deny mechanism (Fly private networking /
  egress policy or an image-level firewall) before claiming default-deny network.
- **Worker maintenance wiring.** Call `sweepOrphanedSandboxMachines` from a
  bounded worker maintenance cycle.
- **Live end-to-end proof.** Gated on production sandbox credentials: create,
  exec, and destroy a real machine and confirm teardown. Verify dependency
  provisioning inside the guest (the candidate workspace ships without
  `node_modules`).
