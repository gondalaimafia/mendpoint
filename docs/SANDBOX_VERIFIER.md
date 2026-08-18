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

## Residual risk: no network isolation (egress)

**Verification runs WITHOUT network isolation.** The Node permission model
restricts filesystem reads and writes, but it does **not** restrict outbound
network access. Consequences:

- An approved-but-malicious verifier command — or a compromised dependency /
  toolchain that a legitimate verifier invokes — can open outbound connections
  and exfiltrate repository contents, environment values, or other data it can
  read.
- The filesystem allowlist does not help here: reading is permitted inside the
  repo root, and egress is the exfiltration channel.

**Egress must be gated at the infrastructure layer**, not in application code.
The Node runtime cannot enforce a network policy on itself. Acceptable controls:

- Linux network namespaces (`netns`) with no default route.
- Host / container firewall (`iptables` / `nftables`) with a default-deny egress
  policy and an explicit allowlist.
- Fly Machines network policy on the sandbox backend, so the verifier machine
  has no outbound path except to approved endpoints.

The Fly Machines sandbox backend is the intended place to carry the egress gate.
The concrete default-deny policy the sandbox app must run under is specified in
"Default-deny egress policy for the sandbox app" below. Until that policy is
provisioned on the `mendpoint-sandbox` app, treat verification as
network-reachable and do not run unreviewed verifier content against sensitive
repositories.

The in-code marker for this residual risk lives in
`packages/repair/src/verify.ts` (search for `network isolation` / `egress`) so
the disclosure cannot silently regress.

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
- `MENDPOINT_SANDBOX_FLY_IMAGE` — the digest-pinned sandbox image
  (`name@sha256:<64 hex>`; see `docs/SANDBOX_IMAGE.md`). Required on the live path:
  there is no default, and an unset or tag-based image fails closed.
- The existing approval gates remain required in production
  (`MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION` and/or
  `MENDPOINT_APPROVED_VERIFIER_SHA256S`).

### What still runs in the worker container after this change

- All verification when no sandbox is configured (the default `local` backend).
- Workspace enumeration and the approval-gate checks themselves (reading the repo
  tree and hashing `node-check` files) run in the worker before dispatch.
- The residual egress gate is carried by the Fly Machine's network policy: this
  change puts execution inside a microVM, and the default-deny egress policy on
  the sandbox app specified in the next section must be provisioned for full
  network containment.

## Default-deny egress policy for the sandbox app

Selecting `MENDPOINT_SANDBOX_KIND=fly_machines` moves verification into a
per-run, force-destroyed Machine on a dedicated Fly app (`MENDPOINT_SANDBOX_FLY_APP`,
e.g. `mendpoint-sandbox`). That relocation buys process and filesystem isolation
but NOT egress containment: Fly grants outbound network by default and the public
Machines API cannot disable it through Machine config. The egress gate is
therefore an app-level control an operator provisions once on the sandbox app; it
is not something application code can turn on for itself.

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

How to provision it depends on the Fly org's networking controls (org-level
egress rules / firewall on the `mendpoint-sandbox` app, or a Machine image whose
entrypoint drops outbound routes before running the verifier). Whichever
mechanism is used, the acceptance test is the same: a verifier Machine's attempt
to open an outbound connection to an address outside the allowlist fails. Until
that test passes, the exfiltration channel described under "Residual risk"
remains open even though execution is inside a microVM.

### Operator checklist to enable the sandbox

1. Build and push the sandbox image (`npm run sandbox:image:push`) and pin an
   immutable tag in `MENDPOINT_SANDBOX_FLY_IMAGE`.
2. Create the dedicated `mendpoint-sandbox` Fly app and provision the default-deny
   egress policy above on it.
3. Set the sandbox credential as a secret on each app that verifies (never in
   `fly.toml`): `fly secrets set MENDPOINT_SANDBOX_FLY_TOKEN=... --app <app>`.
   A scoped `MENDPOINT_SANDBOX_FLY_TOKEN` is preferred over a broad `FLY_API_TOKEN`.
4. Confirm `MENDPOINT_SANDBOX_KIND=fly_machines`, `MENDPOINT_SANDBOX_FLY_APP`, and
   `MENDPOINT_SANDBOX_FLY_IMAGE` are set in the deployment config (already wired in
   `fly.toml` and `fly.customer-warden.toml`).

Because the fly_machines backend fails closed, verification refuses rather than
degrading to host execution if steps 1-3 are incomplete — so provision the
sandbox app and token before deploying the config that selects it.
