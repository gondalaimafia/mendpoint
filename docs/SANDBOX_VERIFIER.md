# Sandbox Verifier — Security Model and Residual Risk

The verification path runs untrusted-repo build/test commands through a small set
of predefined profiles (`packages/repair/src/verify.ts`). This document records
what the current hardening does and does not cover, so the residual risk is
documented rather than implicit.

## What is hardened

- **Command parsing fails closed.** `parseVerificationCommand` rejects shell
  metacharacters and arbitrary executables; only a fixed allowlist of profiles
  (`npm test`, `npm run typecheck`, `node check.mjs`, `pytest`, etc.) is accepted.
- **Production fails closed on unapproved commands.** In production a parsed
  command runs only if it clears one of two operator-controlled gates; anything
  else is refused with exit code `126`.
  - **`node-check` — approved by content hash.** The `node-check` profile runs a
    verifier file directly under our Node runtime, so its file content must match
    a SHA-256 hash listed in `MENDPOINT_APPROVED_VERIFIER_SHA256S`, and it
    executes under the Node permission model (`--permission` /
    `--allow-fs-read=<repoRoot>` / `--allow-fs-write=<tmpdir>`).
  - **Every other profile — approved by exact command (operator override).**
    A customer's own test command (`npm test`, `npm run typecheck`, `pytest`,
    ...) cannot be hashed to a single file, so an operator approves the exact
    command by listing it in `MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION`
    (comma- or newline-separated). This is the deliberate, auditable escape
    hatch: it lets a repository we did not write be verified without opening any
    automatic path — an unlisted command still refuses. These commands run with
    the scrubbed environment below but *outside* the Node filesystem permission
    model (npm/pytest/etc. cannot accept those flags), so their filesystem and
    egress containment is carried by the sandbox backend (see the residual-risk
    section). The env-var name reflects exactly that: an operator is explicitly
    allowing verification to run without the in-process Node sandbox.
- **Environment is scrubbed.** In production the child receives only a minimal
  env allowlist (`PATH`, `SystemRoot`, `COMSPEC`, temp dirs, ...) rather than the
  host `process.env`, so host secrets (tokens, DB URLs, provider keys) are not
  forwarded — for *every* production profile, including operator-approved
  commands. The local sandbox in `packages/platform/src/sandbox.ts` applies the
  same scrub to every command it runs.

## Network isolation and its remaining boundary

The Node permission model does not restrict network access, so production does
not rely on it for egress control. The Fly sandbox image installs IPv4 and IPv6
default-deny output policies before it drops privileges. No tenant verification
command starts until the worker has also:

1. verified a fresh Ed25519 acceptance receipt bound to the exact Fly app,
   immutable image digest, policy digest, and protected evidence;
2. observed that a fixed public HTTPS probe is blocked; and
3. observed that a fixed local command still succeeds.

The worker repeats receipt verification and both probes immediately before every
tenant command. Missing, expired, tampered, cross-app, cross-image, or
cross-policy evidence fails closed before Machine creation or execution. The
remaining boundary is operational availability: if the firewall cannot be
installed, the receipt expires, or the probes cannot produce authoritative
results, verification is unavailable rather than network-reachable.

## Wiring: verification runs inside the sandbox when one is configured

`runVerificationCommand` now routes through the configured sandbox backend. After
the production approval gates above pass, if `MENDPOINT_SANDBOX_KIND=fly_machines`
is selected the command runs inside a per-run, isolated Fly Machine
(`packages/repair/src/verify-sandbox.ts`) instead of via `execFile` in the worker
container. The dispatch is **fail-closed**: if isolation cannot be established
(missing credential/app, create/exec failure, or a workspace too large to hand
over intact) verification FAILS and never falls back to host execution.

- **Default is unchanged.** With no `MENDPOINT_SANDBOX_KIND` (or `local`), the
  host `execFile` path runs exactly as before — this change is safe to ship
  before any sandbox infrastructure is provisioned.
- **The approval gates still apply.** The sandbox is an additional containment
  layer, not a replacement for the operator override or the `node-check` hash
  gate; an unapproved command is still refused before it can reach the sandbox.
- **How the workspace reaches the Machine.** The repository working tree
  (excluding `node_modules`, `.git`, build outputs, and symlinks) is uploaded as
  base64 `config.files` at Machine-create time and mounted at `/workspace`; the
  command runs there and its exit code / stdout / stderr are returned. The
  inline-files handoff is text-oriented and bounded (max 5,000 files / 8 MiB); a
  larger tree fails closed rather than being silently truncated.

### Operator configuration required to enable it

- `MENDPOINT_SANDBOX_KIND=fly_machines` — select the sandbox backend.
- `MENDPOINT_SANDBOX_FLY_APP` — the target Fly app for sandbox Machines
  (e.g. `mendpoint-sandbox`).
- `MENDPOINT_SANDBOX_FLY_TOKEN` (preferred, narrower blast radius) or
  `FLY_API_TOKEN` — the credential. Without a resolvable token the run fails
  closed rather than degrading to the no-op mock or host path.
- `MENDPOINT_SANDBOX_FLY_IMAGE` — REQUIRED, and digest-pinned
  (`name@sha256:<64 hex>`). This image IS the isolation boundary, so a floating
  `:latest` tag is not acceptable: it can change with no review and no
  reproducibility. There is no code default — an unset, empty, or tag-based
  value FAILS CLOSED (`sandbox_image_unresolved` / `sandbox_image_not_pinned` in
  `packages/platform/src/fly-sandbox.ts`), refusing the host fallback rather than
  degrading. Pin it in the reviewed deployment config so a change to the
  isolation boundary is diffable; note that a Fly secret of the same name would
  override the config and is invisible to review. See `docs/SANDBOX_IMAGE.md`
  ("Pin production to an immutable reference").
- The existing approval gates remain required in production
  (`MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION` and/or
  `MENDPOINT_APPROVED_VERIFIER_SHA256S`).
- `MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64` — the canonical signed receipt.
- `MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64` — the exact
  Ed25519 verification key.
- `MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID` — the trusted key identity.
- `MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST` — SHA-256 of the reviewed image
  entrypoint policy. Production startup cryptographically validates these four
  values and the worker revalidates them immediately before every command.

### What still runs in the worker container after this change

- All verification when no sandbox is configured (the default `local` backend).
- Workspace enumeration and the approval-gate checks themselves (reading the repo
  tree and hashing `node-check` files) run in the worker before dispatch.
- The immutable sandbox image and signed acceptance authority carry the egress
  gate. The shared worker never executes the tenant command as a fallback.

## Default-deny egress policy for the sandbox app

Selecting `MENDPOINT_SANDBOX_KIND=fly_machines` moves verification into a
per-run, force-destroyed Machine on a dedicated Fly app (`MENDPOINT_SANDBOX_FLY_APP`,
e.g. `mendpoint-sandbox`). Fly grants outbound network by default and the public
Machines API cannot disable it through Machine config, so the immutable image
installs the policy before it runs the unprivileged workload.

The policy the sandbox app MUST run under:

- **Default deny.** No outbound route from a sandbox Machine except an explicit
  allowlist. A verifier that needs no network (the common case) reaches nothing.
- **Dedicated app, no production reach.** The sandbox app is separate from the
  API/web/worker apps and shares no private network with them, so a sandbox
  Machine cannot reach production databases, internal services, or object stores.
- **No inbound services.** Sandbox Machines declare no services and accept no
  inbound connections; they are created, exec'd, and destroyed by the worker.
- **Allowlist only what a verifier legitimately needs.** For example a package
  registry mirror if dependency install must run inside the Machine; pin it to
  specific hosts rather than opening general egress. Prefer pre-baking
  dependencies into the sandbox image (`Dockerfile.sandbox`, see
  `docs/SANDBOX_IMAGE.md`) so the allowlist can stay empty.

`scripts/start-sandbox-entrypoint.sh` is the reviewed policy source. The protected
`.github/workflows/sandbox-egress-acceptance.yml` workflow proves the exact image
and has two mandatory observations:

1. a verifier Machine's attempt to open an outbound connection to an address
   **outside** the allowlist **FAILS**, and
2. a normal, in-allowlist verification **COMPLETES** inside the Machine.

This default-deny egress policy is a **HARD PREREQUISITE**, not a follow-up. The
workflow signs the two observations with the protected Ed25519 authority and
rotates the exact receipt onto the verifying app. The receipt is valid for less
than 24 hours, so stale evidence makes verification unavailable rather than
silently weakening isolation.

### Operator checklist to enable the sandbox

1. Build and push the sandbox image using `fly.sandbox.toml`, and pin the
   immutable `@sha256:` digest in both deployment configs and the protected
   `SANDBOX_IMAGE_DIGEST` environment variable. Never leave it as `:latest`.
2. Create the dedicated `mendpoint-sandbox` Fly app. The reviewed image entrypoint
   is the default-deny enforcement boundary.
3. Set the sandbox credential as a secret on each app that verifies (never in
   `fly.toml`): `fly secrets set MENDPOINT_SANDBOX_FLY_TOKEN=... --app <app>`.
   A scoped `MENDPOINT_SANDBOX_FLY_TOKEN` is preferred over a broad `FLY_API_TOKEN`.
4. Confirm `MENDPOINT_SANDBOX_KIND=fly_machines` and `MENDPOINT_SANDBOX_FLY_APP`
   are present in the deployment config (wired in `fly.toml` and
   `fly.customer-warden.toml`), and that `MENDPOINT_SANDBOX_FLY_IMAGE` has been
   pinned to a digest (step 1) rather than left empty.
5. Run the protected `Sandbox egress acceptance` workflow with confirmation
   `SANDBOX_EGRESS_ACCEPTED`. It starts one bounded Machine, verifies the exact
   image and both probes, destroys the Machine, signs the receipt, rotates the
   verifying app secrets, and requires `/livez` and `/healthz` to recover.

Because the fly_machines backend fails closed, verification refuses rather than
degrading to host execution if any authority is incomplete, invalid, or expired.
