# Sandbox Runtime Image

The Fly Machines sandbox backend (`packages/platform/src/fly-sandbox.ts`) runs
each verification in its own ephemeral microVM. This document describes the
purpose-built image that Machine boots — `Dockerfile.sandbox` — what is in it and
why, how to build and push it, how to roll back, and its security posture.

This is a **different, minimal image** from the application image (`./Dockerfile`).
The app image runs the API/web/worker/transformer services; the sandbox image
does one thing: run a single verification command against an uploaded tenant
workspace and then get destroyed.

## Lifecycle (where the image is used)

Per run, the adapter (`fly-sandbox.ts`):

1. `createMachine` from the configured image (`MENDPOINT_SANDBOX_FLY_IMAGE`, or
   `fly.image`), with `auto_destroy: true`, uploading **only the caller tenant's**
   workspace files to `/workspace` (`collectWorkspaceFiles`). There is **no default
   image**: on the live path the image must be present and digest-pinned
   (`name@sha256:<64 hex>`) or the run fails closed (see below).
2. `waitForState "started"` — the image's `CMD ["sleep", "infinity"]` keeps the
   Machine's main process alive so an exec can attach.
3. `exec` the verification command as `/bin/sh -c "<command>"`.
4. `destroyMachine` in a `finally` — **always torn down**, including on command
   failure and on the wall-clock cap.

The adapter is fail-closed: if a Machine cannot be created or started, the run
errors and never falls back to the shared host. The same discipline applies to the
image itself — the artifact enforcing isolation. On the live path an unset or
tag-based (non-digest-pinned) image is refused before any Machine is created
(`resolveSandboxImage` in `fly-sandbox.ts`); there is no floating `:latest`
default that could silently supply an unreviewed, mutable artifact.

## What is in the image, and why

Base: `node:22.11.0-bookworm-slim`. Node 22 satisfies the repo engines
(`package.json` `"engines.node": ">=22.5.0"`) and the active
`node-runtime-20-to-22` recipe family, whose verifiers assert the executing
runtime major is 22.

Every added package maps to a real verification call site — nothing is installed
speculatively:

| In the image | Call site that needs it |
| --- | --- |
| **Node 22 + npm** (from base) | `node -e "…"` recipe verifiers (`packages/transformer/src/recipe.ts`) and the `npm-test` / `npm-build` / `npm-typecheck` / `npm-lint` profiles (`packages/repair/src/verify.ts`), which drive vitest/jest through the project's own `npm test` script. |
| **git** | Tooling the verify path shells out to assumes a `git` binary (npm git-dependencies, tests that read git state); repository sources are git-materialized upstream. |
| **python3** | The `pytest` / `python3 -m pytest` profile (`parseVerificationCommand` in `verify.ts`) and the Python fixtures. |
| **python3-pytest** | Makes the bare `pytest` command (the `pytest` profile) resolve on `PATH`. |
| **python3-venv** | Isolated dependency installs for Python projects (Debian bookworm blocks system-level `pip install` under PEP 668). |
| **python3-pip** | Package installs inside a venv. |
| **ca-certificates** | TLS trust for npm registry / PyPI fetches during verify — the slim base does not ship CA certs. |
| **`python` symlink** | Verifiers that invoke the unversioned `python` name. |

### Deliberately NOT included

The `verify.ts` parser also recognizes `go test ./...`, `cargo test`, `mvn test`,
`gradle test`, and `bundle exec rspec`. The Go / Rust / JDK+Maven / Gradle / Ruby
toolchains are **intentionally omitted** — they are heavy, and no active recipe
family targets them (the only non-Node fixture is a single Ruby consumer file
under `fixtures/examples/`, which is not driven through the sandbox). Likewise
`build-essential` / `node-gyp` native-addon compilation is omitted.

If a recipe family that verifies in one of those languages goes live, add the
specific toolchain to `Dockerfile.sandbox` (mapped to its call site, same as the
table above), rebuild, and push a new tag.

### Known runtime notes to confirm on the first real build

- **Node-version-major verifiers.** The `node-runtime-18-to-20` recipe's
  `node-major` verifier asserts the *executing* runtime is Node 20; this Node 22
  image cannot satisfy it. The active fixture (`node-runtime-20-to-22`) wants
  Node 22 and matches. A recipe that must verify on a different Node major needs
  a matching-major image selected via `MENDPOINT_SANDBOX_FLY_IMAGE`.
- **Uploaded-file ownership.** Fly writes `config.files` into `/workspace`; the
  Machine runs as the unprivileged `node` user. Read-only verifiers (the
  `node -e` checks, reading `package.json`) are unaffected. Verifiers that write
  into the tree should target a writable temp dir. Confirm ownership/writability
  on the first live run and adjust `Dockerfile.sandbox` (e.g. `/workspace` mode)
  if a write-heavy profile needs it.

## Build and push (operator-only)

`scripts/build-sandbox-image.mjs` builds and (with `--push`) pushes to
`registry.fly.io/mendpoint-sandbox`. **It is never run automatically** — no CI
step and no npm lifecycle hook invoke it. Run it by hand from a machine with
`docker` and an authenticated `flyctl`.

```sh
# Build locally (safe, no push):
node scripts/build-sandbox-image.mjs
#   or: npm run sandbox:image

# Build + push :<content-hash> and :latest to the Fly registry:
node scripts/build-sandbox-image.mjs --push
#   or: npm run sandbox:image:push

# Preview the exact commands without running them:
node scripts/build-sandbox-image.mjs --dry-run

# Override the tag:
node scripts/build-sandbox-image.mjs --tag=v3 --push
```

The tag defaults to `sha-<first-12-of-sha256(Dockerfile.sandbox)>`, so an
identical image definition always yields the same immutable tag. On `--push`, the
script runs `flyctl auth docker`, pushes both the immutable tag and `:latest`,
then prints the resolved `@sha256:…` digest so you can pin production to it.

### Pin the deployment to an immutable digest (required)

There is **no default image**. The live sandbox path requires
`MENDPOINT_SANDBOX_FLY_IMAGE` (or `fly.image`) to be set to a **digest-pinned**
reference; an unset image or a mutable tag (`:latest`, `:v1`, ...) is refused and
the run fails closed. Pin the deployment to the immutable digest the push printed:

```sh
fly secrets set \
  MENDPOINT_SANDBOX_FLY_IMAGE=registry.fly.io/mendpoint-sandbox@sha256:<digest> \
  --app <mendpoint-app>
```

This is the reviewed, reproducible, auditable form: the exact artifact enforcing
isolation is fixed and cannot change without a config change that goes through
review.

#### Local/dev escape hatch (explicit, dev only)

For local runs against a dev image that is not yet digest-pinned, set the loud,
explicit opt-out `MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE=1`. It relaxes **only**
the digest-pin requirement (a tag becomes acceptable); it never permits an absent
image and never enables host fallback. It defaults off and must never be set in
production. The deterministic mock client (an injected client, or an explicitly
forced mock mode) never pulls a real image, so it does not require a pin.

## Rollback

The env var is the rollback lever — no redeploy of the app image is needed:

```sh
# Point back at a previous known-good tag or digest:
fly secrets set \
  MENDPOINT_SANDBOX_FLY_IMAGE=registry.fly.io/mendpoint-sandbox:sha-<previous> \
  --app <mendpoint-app>
```

Immutable content-hash tags (and `@sha256` digests) make rollback exact: each
tag is a specific image definition. Keep the previous tag around (do not delete
it from the registry) until a new one is proven in production.

## Security posture

- **Non-root.** The image drops to the unprivileged `node` user (uid 1000);
  `/workspace` is owned by that user. `USER node` is the final instruction.
- **No baked secrets or network credentials.** No tokens, keys, or registry
  credentials are in the image. `flyctl auth docker` uses the operator's own
  session at push time; the build script reads and writes no credentials.
- **Minimal surface.** Only the packages mapped to call sites above are present;
  no compilers, extra language runtimes, or network tools beyond what verify
  needs.
- **Ephemeral and always destroyed.** Each run gets its own Machine
  (`auto_destroy: true`); the adapter destroys it in a `finally`, including on
  failure and on the wall-clock cap. There is no shared long-lived sandbox host.
- **Tenant-scoped uploads.** Only the caller tenant's workspace files are
  uploaded (`collectWorkspaceFiles`); no host process or other tenant's data
  enters the Machine.
- **Egress caveat (unchanged).** As documented in `docs/SANDBOX_VERIFIER.md`, the
  verification command itself is not network-isolated by the Node runtime; egress
  control is an infrastructure-layer concern (Fly network policy). This image does
  not add egress isolation and does not weaken it.
