/**
 * Error-code -> self-service guidance catalog (S3 diagnostics).
 *
 * The API surfaces failures as machine codes (`throw new Error("<code>")`, or a
 * `{ error: "<code>", requestId }` envelope). Those codes are precise but opaque
 * to a customer. This module is the single source of truth that turns a code
 * into plain-English guidance a customer can act on WITHOUT contacting us:
 * what happened, the likely cause, and concrete recovery steps.
 *
 * `explainError(code | Error | envelope)` always returns a populated entry.
 * Unknown codes degrade gracefully to a generic-but-useful entry (and known
 * code *families* such as `recipe_precondition_failed:*` or `usage_*` degrade
 * to their family entry) so a customer is never shown a blank or a bare code.
 *
 * This is a presentation/diagnosis layer only. It never changes a thrown code
 * or any control flow; it is pure data + lookup, safe to import from both the
 * API (NodeNext) and the web UI (including client components).
 */

/** A customer-facing explanation of a single failure code. */
export type ExplainedError = {
  /** The normalized machine code that was looked up (echoed even when unknown). */
  code: string;
  /** Short human title for the failure. */
  title: string;
  /** Plain-English description of what happened. */
  whatHappened: string;
  /** The most likely underlying cause. */
  likelyCause: string;
  /** Concrete, self-service recovery steps in order. */
  howToFix: string[];
  /** In-app route (or docs anchor) that helps resolve it, when one applies. */
  docsHref?: string;
};

/** A catalog entry is an {@link ExplainedError} without its own `code`. */
export type ErrorGuidanceEntry = Omit<ExplainedError, "code">;

/** Anything a caller might have on hand when a request fails. */
export type ExplainErrorInput =
  | string
  | Error
  | { error?: unknown; message?: unknown; code?: unknown }
  | null
  | undefined;

/**
 * Exact-code catalog. Keys are the exact machine codes the API throws or
 * returns. Grouped by theme in source order for readability only; lookup is by
 * exact key.
 */
const CATALOG: Readonly<Record<string, ErrorGuidanceEntry>> = {
  // ── Setup / tenant scope ───────────────────────────────────────────────
  tenant_scope_required: {
    title: "Workspace could not be identified",
    whatHappened:
      "The request reached the API without a workspace (tenant) attached, so it was stopped before reading any data.",
    likelyCause:
      "The API key or sign-in session is missing its workspace, or a blank workspace id was sent.",
    howToFix: [
      "Sign in again, or reissue your API key from workspace settings so it carries a workspace.",
      "If you set an x-tenant-id header manually, make sure it is a non-empty workspace id.",
      "Run the diagnostics page to confirm your workspace resolves.",
    ],
    docsHref: "/diagnostics",
  },
  authenticated_principal_required: {
    title: "You are not signed in",
    whatHappened: "This action needs an authenticated user or API key, and none was found on the request.",
    likelyCause: "The session expired, or the request was made without an Authorization header.",
    howToFix: [
      "Sign in again from the product login page.",
      "For API calls, send Authorization: Bearer <your api key>.",
    ],
    docsHref: "/access",
  },
  repos_root_not_configured: {
    title: "Repository storage is not configured",
    whatHappened: "The service cannot place repository checkouts because its storage root is not set.",
    likelyCause: "The REPOS_ROOT environment variable is missing in this deployment.",
    howToFix: [
      "Set REPOS_ROOT to a writable directory and restart the service.",
      "If you run a managed workspace, check the system status page for a storage warning.",
    ],
    docsHref: "/status",
  },
  tenant_id_not_path_safe: {
    title: "Workspace id contains unsupported characters",
    whatHappened: "The workspace id could not be used as a safe storage path, so the request was refused.",
    likelyCause: "The workspace id includes characters (such as slashes or dots) that are not path-safe.",
    howToFix: [
      "Use a workspace id made of letters, numbers, dashes, and underscores.",
      "Recreate the workspace if the id was set by hand.",
    ],
    docsHref: "/diagnostics",
  },

  // ── Authentication / identity ──────────────────────────────────────────
  oidc_configuration_incomplete: {
    title: "Single sign-on is not fully configured",
    whatHappened: "An OIDC sign-in was attempted but the identity provider settings are incomplete.",
    likelyCause: "The issuer, audience, or JWKS URL is missing from the SSO configuration.",
    howToFix: [
      "Set the OIDC issuer, audience, and JWKS URL in your workspace SSO settings.",
      "Confirm the issuer URL uses HTTPS.",
    ],
    docsHref: "/access",
  },
  oidc_mfa_required: {
    title: "Multi-factor authentication is required",
    whatHappened: "Your sign-in token did not prove that multi-factor authentication was completed.",
    likelyCause: "MFA is enforced for this workspace but the login did not include an MFA step.",
    howToFix: [
      "Sign in again and complete the multi-factor prompt.",
      "Enroll a second factor with your identity provider if you have not already.",
    ],
    docsHref: "/access",
  },
  delegated_actor_expired: {
    title: "Delegated access has expired",
    whatHappened: "A delegated-actor assertion was accepted earlier but has now passed its expiry.",
    likelyCause: "The delegation window elapsed between issuing and using the token.",
    howToFix: [
      "Request a fresh delegated token and retry.",
      "Shorten the gap between obtaining and using delegated access.",
    ],
    docsHref: "/access",
  },
  human_review_identity_required: {
    title: "Reviewer identity is required",
    whatHappened: "A review decision was submitted without an identified reviewer.",
    likelyCause: "The review action was sent without reviewer identity headers or session.",
    howToFix: [
      "Sign in as the reviewer before approving or rejecting.",
      "Confirm your session carries a user id.",
    ],
    docsHref: "/access",
  },

  // ── Integration (SCM / GitHub / connect / scan) ────────────────────────
  self_serve_connect_disabled: {
    title: "Self-serve repository connect is turned off",
    whatHappened: "The self-serve connect endpoint is inert in this deployment, so the connect request returned not found.",
    likelyCause: "The self-serve connect feature flag is not enabled for this environment.",
    howToFix: [
      "Enable self-serve connect for your workspace, or connect the repository through the Connect GitHub setup flow.",
      "If you expected this to be on, check the system status page for the enabled feature set.",
    ],
    docsHref: "/install",
  },
  github_app_credentials_missing: {
    title: "GitHub App credentials are not configured",
    whatHappened: "Connecting or reading a GitHub repository needs the GitHub App credentials, and they are not set.",
    likelyCause: "The GitHub App id or private key is missing from this deployment.",
    howToFix: [
      "Install and configure the Mendpoint GitHub App, then reconnect the repository.",
      "Confirm the GitHub App credentials are present before retrying the connect.",
    ],
    docsHref: "/install",
  },
  scm_connection_revoked: {
    title: "This repository connection was revoked",
    whatHappened: "The action needs a live source-control connection, but this one has been revoked.",
    likelyCause: "The connection was revoked earlier, or its credential was rotated out.",
    howToFix: [
      "Reconnect the repository to create a fresh connection.",
      "Re-materialize the checkout after reconnecting.",
    ],
    docsHref: "/install",
  },
  connect_branch_invalid: {
    title: "The branch name is not valid",
    whatHappened: "The branch supplied for the connection failed validation, so the repository was not connected.",
    likelyCause: "The branch name is empty, too long, or contains characters git does not allow.",
    howToFix: [
      "Use an existing branch name such as main.",
      "Avoid spaces, control characters, or a leading or trailing slash.",
    ],
    docsHref: "/install",
  },
  "provider not monitored by tenant": {
    title: "Your workspace does not monitor that provider",
    whatHappened: "A scan was requested for a provider that none of your repositories monitor, so nothing ran.",
    likelyCause: "No consumer in this workspace is registered against that provider.",
    howToFix: [
      "Add the provider to a repository so it is monitored, then scan again.",
      "Or scan a provider your workspace already monitors.",
    ],
    docsHref: "/consumer",
  },
  "no monitored providers to scan": {
    title: "No providers are monitored yet",
    whatHappened: "A scan was requested but this workspace is not monitoring any provider, so there was nothing to scan.",
    likelyCause: "No provider has been linked to any repository in this workspace.",
    howToFix: [
      "Register a repository and link it to the provider you want to watch.",
      "Then trigger the scan again.",
    ],
    docsHref: "/consumer",
  },

  // ── Config ─────────────────────────────────────────────────────────────
  transformer_gate_config_missing: {
    title: "Transformer gate is not configured",
    whatHappened: "A transformer action was gated, but the gate configuration is absent so it defaulted to denied.",
    likelyCause: "The transformer gate config value is blank in this environment.",
    howToFix: [
      "Provide a valid transformer gate configuration for your workspace.",
      "Confirm the gate config was loaded on the system status page.",
    ],
    docsHref: "/status",
  },
  transformer_gate_config_malformed: {
    title: "Transformer gate configuration is invalid",
    whatHappened: "The transformer gate configuration was present but could not be parsed, so the action was denied.",
    likelyCause: "The gate config is not valid JSON, uses the wrong keys, or an unsupported schema version.",
    howToFix: [
      "Correct the gate configuration so it is valid JSON with the expected keys and version.",
      "Re-check the transformer setup after fixing the config.",
    ],
    docsHref: "/status",
  },

  // ── Execution ──────────────────────────────────────────────────────────
  model_training_tier_forbidden_for_tenant: {
    title: "The selected model tier is not allowed for your workspace",
    whatHappened: "A run stopped before calling the model because the resolved model uses a training tier your workspace may not use.",
    likelyCause: "Model routing selected a training-tier model that is not on your workspace allowlist.",
    howToFix: [
      "Choose a model your workspace is permitted to use, or update the allowed model tier for the workspace.",
      "If you opted into a contributor training tier, confirm the allowlist still includes that model.",
    ],
    docsHref: "/trust",
  },
  warden_candidate_delivery_evidence_invalid: {
    title: "Delivery evidence did not validate",
    whatHappened: "A Warden candidate was produced but its delivery evidence failed validation, so it was not delivered.",
    likelyCause: "The evidence bundle was incomplete, out of date, or did not match the candidate.",
    howToFix: [
      "Re-run the candidate so fresh delivery evidence is generated.",
      "Confirm the checkout and verification commands are current before retrying.",
    ],
    docsHref: "/agent",
  },
  recipe_precondition_failed: {
    title: "A migration precondition was not met",
    whatHappened: "A transformer recipe checked its preconditions against your code and abstained because one did not hold.",
    likelyCause:
      "The file, dependency, or version the recipe expected was not present, so the recipe safely declined to change anything.",
    howToFix: [
      "Open the failing run to see which precondition and file were reported after the colon in the code.",
      "Bring the target file or dependency to the expected state, then re-run the recipe.",
      "This is a safe abstain: no changes were made to your repository.",
    ],
    docsHref: "/transformer",
  },
  coordinator_lease_rejected: {
    title: "Another worker holds this work",
    whatHappened: "The coordinator refused the action because the lease is held by another worker or has expired.",
    likelyCause: "A concurrent worker is processing the same attempt, or the lease timed out.",
    howToFix: [
      "Wait for the in-progress attempt to finish, then retry.",
      "If nothing is running, retry to acquire a fresh lease.",
    ],
    docsHref: "/status",
  },
  coordinator_scope_denied: {
    title: "That work belongs to another workspace",
    whatHappened: "The coordinator denied the request because the authenticated workspace does not match the requested one.",
    likelyCause: "The request targeted an attempt owned by a different workspace.",
    howToFix: [
      "Retry using credentials for the workspace that owns the attempt.",
      "Confirm you are operating in the correct workspace.",
    ],
    docsHref: "/diagnostics",
  },

  // ── Quota / entitlement ────────────────────────────────────────────────
  usage_entitlement_required: {
    title: "No active plan for metered runs",
    whatHappened: "A run needed to reserve metered usage, but your workspace has no active entitlement, so it was refused.",
    likelyCause: "The workspace has no active plan or usage entitlement.",
    howToFix: [
      "Choose or activate a plan on the billing page.",
      "Once an entitlement is active, retry the run.",
    ],
    docsHref: "/billing",
  },
  usage_quota_exceeded: {
    title: "Usage quota exceeded",
    whatHappened: "Reserving usage for this run would exceed your workspace's metered quota, so it was held back.",
    likelyCause: "The workspace has consumed its allotted metered capacity for the current period.",
    howToFix: [
      "Wait for the quota to reset next period, or raise your plan quota on the billing page.",
      "Cancel or narrow pending work to stay within the current quota.",
    ],
    docsHref: "/billing",
  },

  // ── Synthetic diagnostics-check codes ──────────────────────────────────
  // These back individual live checks on the diagnostics page. They are not
  // thrown by the API; they exist so every failing check carries the same
  // actionable guidance shape.
  diagnostics_workspace_missing: {
    title: "Workspace record not found",
    whatHappened: "Your API key resolved a workspace id, but no matching workspace record exists.",
    likelyCause: "The workspace was removed, or the key points at a workspace that was never created.",
    howToFix: [
      "Create a workspace from the signup flow, or reissue a key for an existing workspace.",
      "Contact your workspace owner if you expected this workspace to exist.",
    ],
    docsHref: "/signup",
  },
  diagnostics_repository_not_connected: {
    title: "No repository is connected",
    whatHappened: "Your workspace has no active source-control connection, so scans and runs have nothing to act on.",
    likelyCause: "A repository has not been connected yet, or every connection has been revoked.",
    howToFix: [
      "Connect a repository through the Connect GitHub setup flow.",
      "If a connection was revoked, create a new one.",
    ],
    docsHref: "/install",
  },
  diagnostics_checkout_not_materialized: {
    title: "No repository checkout is available",
    whatHappened: "A repository is connected but no checkout snapshot has been materialized, so runs have no code to read.",
    likelyCause: "The connected repository has not been snapshotted yet, or its snapshots were purged by retention.",
    howToFix: [
      "Materialize a checkout for the connected repository from the setup flow.",
      "Re-connect and re-snapshot if retention removed the previous checkout.",
    ],
    docsHref: "/install",
  },
  diagnostics_no_monitored_provider: {
    title: "No provider is monitored",
    whatHappened: "Your workspace is not monitoring any API provider, so there is no change source to scan against.",
    likelyCause: "No provider has been linked to a repository in this workspace.",
    howToFix: [
      "Link a provider to one of your repositories.",
      "Then run a scan to confirm impact detection works.",
    ],
    docsHref: "/consumer",
  },
  diagnostics_model_provider_unconfigured: {
    title: "Model provider endpoint is not configured",
    whatHappened: "The service is in local-only model mode but no permitted model endpoint is configured, so runs cannot call a model.",
    likelyCause: "Local-only egress is enforced without a matching local model endpoint configured.",
    howToFix: [
      "Configure a model endpoint that satisfies your egress mode.",
      "Review the model egress posture on the system status page.",
    ],
    docsHref: "/status",
  },
  diagnostics_recent_run_failed: {
    title: "A recent run failed",
    whatHappened: "At least one recent run in your workspace ended in a failed state.",
    likelyCause: "The most recent failure carries its own error code with specific guidance.",
    howToFix: [
      "Open Warden runs to see the failing run and its reported error.",
      "Follow the guidance attached to that run's error code.",
    ],
    docsHref: "/agent",
  },
};

/**
 * Family fallbacks for graceful degradation. When an exact code (and its
 * colon-base) is not catalogued, the first prefix match here supplies useful
 * guidance for the whole family. Ordered most-specific first.
 */
const FAMILY_GUIDANCE: ReadonlyArray<readonly [string, ErrorGuidanceEntry]> = [
  [
    "recipe_precondition_failed",
    CATALOG.recipe_precondition_failed!,
  ],
  [
    "transformer_gate_",
    {
      title: "Transformer gate check failed",
      whatHappened: "A transformer action was blocked by the gate configuration.",
      likelyCause: "The gate config is missing, malformed, or does not grant this workspace or environment.",
      howToFix: [
        "Review and correct the transformer gate configuration.",
        "Confirm your workspace is granted for the requested action.",
      ],
      docsHref: "/status",
    },
  ],
  [
    "coordinator_",
    {
      title: "Coordinator refused the action",
      whatHappened: "The multi-worker coordinator declined this request.",
      likelyCause: "A lease, fence, scope, or source-binding check did not pass.",
      howToFix: [
        "Retry once any in-progress attempt finishes.",
        "Confirm you are using the owning workspace's credentials.",
      ],
      docsHref: "/status",
    },
  ],
  [
    "usage_",
    {
      title: "Usage or billing check failed",
      whatHappened: "A usage or entitlement rule stopped this request.",
      likelyCause: "Your plan, quota, or usage records did not permit the requested work.",
      howToFix: [
        "Review your plan and quota on the billing page.",
        "Activate or raise an entitlement, then retry.",
      ],
      docsHref: "/billing",
    },
  ],
  [
    "oidc_",
    {
      title: "Single sign-on check failed",
      whatHappened: "An OIDC sign-in could not be completed.",
      likelyCause: "The SSO configuration is incomplete or the token did not meet policy.",
      howToFix: [
        "Confirm issuer, audience, JWKS URL, and MFA policy in SSO settings.",
        "Sign in again after correcting the configuration.",
      ],
      docsHref: "/access",
    },
  ],
  [
    "github_",
    {
      title: "GitHub integration check failed",
      whatHappened: "A GitHub connection or snapshot step did not succeed.",
      likelyCause: "GitHub App credentials, installation, or access were missing or invalid.",
      howToFix: [
        "Reinstall or reconfigure the GitHub App and reconnect the repository.",
        "Re-materialize the checkout after the connection is healthy.",
      ],
      docsHref: "/install",
    },
  ],
  [
    "scm_",
    {
      title: "Repository connection check failed",
      whatHappened: "A source-control connection or repository step did not succeed.",
      likelyCause: "The connection was invalid, revoked, or belonged to another workspace.",
      howToFix: [
        "Reconnect the repository and try again.",
        "Confirm the connection belongs to your workspace.",
      ],
      docsHref: "/install",
    },
  ],
  [
    // The brief references a `mendpoint_config_*` family that does not exist in
    // this worktree; degrade any such code to actionable config guidance so it
    // is never shown raw.
    "mendpoint_config_",
    {
      title: "A configuration value is missing or invalid",
      whatHappened: "A required Mendpoint configuration value was not accepted, so the action stopped.",
      likelyCause: "An environment or workspace configuration value is missing or malformed.",
      howToFix: [
        "Review your workspace configuration for the value named in the code.",
        "Check the system status page for configuration warnings.",
      ],
      docsHref: "/status",
    },
  ],
];

const GENERIC_GUIDANCE: ErrorGuidanceEntry = {
  title: "Something did not complete",
  whatHappened: "The request stopped with a status the console did not have specific guidance for.",
  likelyCause: "This is an uncommon or new condition; the code below identifies it exactly.",
  howToFix: [
    "Run the diagnostics page to check your setup, authentication, integration, and recent runs.",
    "Check the system status page for a service-wide issue.",
    "Retry the action; if it persists, note the code shown here.",
  ],
  docsHref: "/diagnostics",
};

/** Normalize any supported input into a bare machine code string. */
export function normalizeErrorCode(input: ExplainErrorInput): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return codeFromString(input);
  if (input instanceof Error) return codeFromString(input.message);
  if (typeof input === "object") {
    const record = input as { error?: unknown; message?: unknown; code?: unknown };
    if (typeof record.error === "string") return codeFromString(record.error);
    if (record.error && typeof record.error === "object") {
      const nested = record.error as { code?: unknown; message?: unknown };
      if (typeof nested.code === "string") return nested.code.trim();
      if (typeof nested.message === "string") return codeFromString(nested.message);
    }
    if (typeof record.code === "string") return record.code.trim();
    if (typeof record.message === "string") return codeFromString(record.message);
  }
  return "";
}

/**
 * A string may be a bare code, or a JSON envelope such as
 * `{"error":"usage_quota_exceeded","requestId":"..."}` (some client surfaces
 * throw `new Error(JSON.stringify(json))`). Unwrap the envelope when present.
 */
function codeFromString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        const code = normalizeErrorCode(parsed as ExplainErrorInput);
        if (code) return code;
      }
    } catch {
      /* fall through to the raw string */
    }
  }
  return trimmed;
}

function lookupGuidance(code: string): ErrorGuidanceEntry {
  if (!code) return GENERIC_GUIDANCE;
  const exact = CATALOG[code];
  if (exact) return exact;
  // Colon-delimited codes (e.g. recipe_precondition_failed:path:pointer) look up
  // their base. Space-delimited templated codes (feature_disabled: <id> ...) too.
  const base = code.split(/[:\s]/, 1)[0];
  if (base && base !== code) {
    const baseEntry = CATALOG[base];
    if (baseEntry) return baseEntry;
  }
  for (const [prefix, entry] of FAMILY_GUIDANCE) {
    if (code.startsWith(prefix)) return entry;
  }
  return GENERIC_GUIDANCE;
}

/**
 * Explain a failure for a customer. Accepts a bare code, an Error, or an
 * error envelope object. Always returns a populated {@link ExplainedError};
 * unknown codes fall back to generic-but-useful guidance that still names the
 * code and tells the customer what to do next.
 */
export function explainError(input: ExplainErrorInput): ExplainedError {
  const code = normalizeErrorCode(input);
  return { code: code || "unknown_error", ...lookupGuidance(code) };
}

/** The exact machine codes that have a dedicated (non-family) catalog entry. */
export function cataloguedErrorCodes(): string[] {
  return Object.keys(CATALOG);
}
