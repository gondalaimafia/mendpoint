# Production GitHub App setup

How to create and configure the production Mendpoint GitHub App so a signed installation
completes the state-based tenant claim end to end. Every value below is derived from the
code; the authoritative sources are [`packages/github/src/app-install.ts`](../packages/github/src/app-install.ts),
[`packages/github/src/app-lifecycle.ts`](../packages/github/src/app-lifecycle.ts),
[`packages/github/src/owner-bindings.ts`](../packages/github/src/owner-bindings.ts),
the API routes in [`apps/api/src/server.ts`](../apps/api/src/server.ts)
(`/webhooks/github`, `/github/app/*`), and the browser return page in
[`apps/web/app/github/setup/`](../apps/web/app/github/setup/setup-client.tsx).
A machine-readable manifest with the same values lives at
[`docs/github-app-manifest.json`](github-app-manifest.json).

## 1. Create the App on GitHub

Create the App manually at **Settings → Developer settings → GitHub Apps → New GitHub App**
(organization-owned for production). Use these exact form values:

| Field | Value |
|-------|-------|
| App name | `Mendpoint` (slug must match `GITHUB_APP_SLUG`) |
| Homepage URL | Public web origin, e.g. `https://mendpoint-talal.fly.dev` |
| Webhook URL | `https://<api-origin>/webhooks/github` |
| Webhook secret | Same value as `GITHUB_WEBHOOK_SECRET` (see below) |
| Setup URL | `https://<web-origin>/github/setup` |
| **Redirect on update** | **Checked — required** (see section 2) |
| Where can this app be installed? | Only on this account (private pilot) |

Repository permissions — the exact set in `GITHUB_DRAFT_DELIVERY_PERMISSIONS`
([`app-lifecycle.ts`](../packages/github/src/app-lifecycle.ts)); the install claim
fails closed with `installation_permissions_incomplete` if any is missing:

| Permission | Access | Why |
|------------|--------|-----|
| Metadata | Read | Repository discovery |
| Contents | Write | Branch and commit creation for migration drafts |
| Pull requests | Write | Draft pull request delivery (never auto-merged) |
| Checks | Read | CI outcome observation on delivered drafts |

Subscribe to events:

| Event | Why |
|-------|-----|
| Pull request | Merge/close feedback on delivered migration PRs |
| Push | Change detection on connected repositories |

`installation` and `installation_repositories` lifecycle events are delivered to every
GitHub App automatically; they are not checkboxes on the form but the webhook route
handles them and they are what bind the installation server-side.

After creating the App, generate a private key (RSA PEM download) and note the numeric
**App ID** and the **slug** from the App URL (`github.com/apps/<slug>`).

## 2. "Redirect on update" is required

The tenant claim only completes when GitHub redirects the browser back to
`/github/setup?state=…&installation_id=…&setup_action=…`. The callback accepts
`setup_action` values `install` **and** `update`
([`server.ts`](../apps/api/src/server.ts) `/github/app/callback`;
[`setup-return.ts`](../apps/web/app/github/setup/setup-return.ts)).

For a **first** installation GitHub always redirects to the Setup URL. For an
**already-installed** App — re-running the wizard, adding repositories, or accepting new
permissions — GitHub only redirects to the Setup URL when **Redirect on update** is
checked. Without it the browser never returns with the state token, the state expires
after 10 minutes, and the state-based tenant claim never completes even though the
installation itself exists on GitHub.

## 3. Required secrets

Set these in the API service environment (Fly secrets in production):

| Variable | Value | Enforced by |
|----------|-------|-------------|
| `GITHUB_APP_ID` | Numeric App ID from the App page | `loadAppCredentials` rejects non-numeric values ([`app-runtime.ts`](../packages/github/src/app-runtime.ts)) |
| `GITHUB_APP_PRIVATE_KEY` | Full PEM private key (`\n` escapes accepted); alternatively `GITHUB_APP_PRIVATE_KEY_PATH` | Must be RSA ≥ 2048 bits or credentials load as null |
| `GITHUB_APP_SLUG` | App slug, e.g. `mendpoint` | Builds `https://github.com/apps/<slug>/installations/new` ([`app-install.ts`](../packages/github/src/app-install.ts)); defaults to `mendpoint` |
| `GITHUB_WEBHOOK_SECRET` | Strong random value (32+ chars); **must equal the webhook secret on the GitHub form** | `/webhooks/github` rejects unsigned or mismatched deliveries with 401 in production; `GitHubAppLifecycle` refuses secrets shorter than 16 chars |
| `GITHUB_APP_INSTALL_EXPERIMENTAL` | `1` | Without it `getGitHubAppConfig().configured` is false and the install path returns 503 in production |
| `GITHUB_APP_OWNER_TENANT_BINDINGS` | JSON owner→tenant map, e.g. `{"gondalaimafia":"tenant_default"}` | Parsed by [`owner-bindings.ts`](../packages/github/src/owner-bindings.ts) (≤ 200 entries, validated GitHub login and tenant id, owner matched case-insensitively) |

`GITHUB_APP_OWNER_TENANT_BINDINGS` is **critical**: the signed `installation` webhook is
the only trusted path that assigns a tenant to a new installation
(`resolveGitHubOwnerTenantBinding` in the `/webhooks/github` route). Without a binding
for the installing owner, the webhook stores the installation with tenant `null`, and
`completeGitHubInstallState` ([`packages/db/src/index.ts`](../packages/db/src/index.ts))
returns `pending` for a tenant-less installation — so the browser claim answers
`202 installation_verification_pending` on every retry, forever. Browser parameters can
never claim an unassigned installation; that is deliberate fail-closed behavior. If the
binding names a tenant that does not exist, the webhook returns
`503 github_owner_binding_tenant_not_found` instead of storing a bad binding.

Optional: `GITHUB_APP_NAME` (display name, default `Mendpoint`) and `GITHUB_APP_MOCK=1`
(forces mock mode; never set in production).

## 4. Install from the Mendpoint /install page

Always start the installation from the Mendpoint **`/install`** wizard, not from the
GitHub Apps settings page. The wizard calls the authenticated
`GET /github/app/install-url`, which creates a single-use 32-byte state token bound to
the current tenant and principal with a 10-minute expiry, then sends the browser to
`https://github.com/apps/<slug>/installations/new?state=…`.

After the user picks repositories, GitHub redirects to `/github/setup`, which posts
`state`, `installation_id`, and `setup_action` to `POST /github/app/callback` and retries
on `202` with backoff (1s, 2s, 4s, 8s, 8s) while the signed webhook lands. The claim
completes exactly once, links consumers to the installation, and audits the completion.

Installing directly from GitHub settings still fires the signed webhook, so the
installation is recorded — but there is no state token, so the browser return shows
"This setup link expired" and no tenant claim happens. Recover by starting a fresh
connection from `/install`; with **Redirect on update** enabled the already-installed App
redirects back with `setup_action=update` and the claim completes.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "GitHub App installation is unavailable for this pilot…" (503 `github_app_install_disabled`) | `installEnabled` is false in production: `GITHUB_APP_ID`/private key missing, `GITHUB_APP_MOCK=1` set, or `GITHUB_APP_INSTALL_EXPERIMENTAL` ≠ `1` | Set all credentials plus `GITHUB_APP_INSTALL_EXPERIMENTAL=1`; remove `GITHUB_APP_MOCK` |
| Setup card stuck on pending, then "GitHub confirmation is taking longer than expected" (202 `installation_verification_pending` until retry budget runs out) | Signed webhook never bound the installation to this tenant: missing `GITHUB_APP_OWNER_TENANT_BINDINGS` entry for the owner, webhook secret mismatch (delivery rejected 401), wrong webhook URL, or the installation is suspended/deleted | Add the owner→tenant binding, verify `GITHUB_WEBHOOK_SECRET` matches the App form, confirm the webhook URL, then press "Check again" — no reinstall needed |
| "Repository access is incomplete" (409 `installation_permissions_incomplete`) | Installation lacks one of metadata:read, contents:write, pull_requests:write, checks:read — typically the App's permissions changed and the org has not accepted them | Accept the pending permission request on GitHub (installation settings), then retry from `/github/setup` or `/install` |
| "Repository access is incomplete" (409 `installation_repository_scope_incomplete`) | Installation includes no verified repository owned by the installing account, or configured consumers could not be linked | Add the pilot repository to the installation's repository selection on GitHub |
| "This setup link expired" (400 `invalid_or_expired_state`) | State older than 10 minutes, already consumed, opened by a different principal/tenant, or install started outside `/install` | Start a new connection from `/install` |
| Webhook deliveries show 401 "invalid signature" | `GITHUB_WEBHOOK_SECRET` does not match the secret on the GitHub App form | Set both to the same strong value and redeliver |
| Webhook returns 503 `github_owner_binding_tenant_not_found` | Owner binding maps to a tenant id that does not exist in the database | Fix the tenant id in `GITHUB_APP_OWNER_TENANT_BINDINGS` |
