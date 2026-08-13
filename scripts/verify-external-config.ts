/**
 * Verify the EXTERNAL configuration Mendpoint self-serve needs.
 *
 * Reports, per capability, whether every required setting is present and
 * plausibly shaped -- and exactly what is missing when it is not.
 *
 * PRIVACY: this script NEVER prints, logs, stores, or transmits a secret value.
 * It only reports presence, a coarse shape verdict (length / prefix / format),
 * and a masked fingerprint (first 2 + last 2 characters) so you can tell two
 * different values apart without revealing either. Nothing leaves this process.
 *
 *   npm run verify:config
 */

type Verdict = "ready" | "missing" | "malformed" | "optional_missing";

type CheckResult = {
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly fix?: string;
};

type Capability = {
  readonly title: string;
  readonly why: string;
  readonly checks: readonly CheckResult[];
};

/** Mask a value so two secrets are distinguishable but neither is revealed. */
function fingerprint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 6) return `(${trimmed.length} chars)`;
  return `${trimmed.slice(0, 2)}…${trimmed.slice(-2)} (${trimmed.length} chars)`;
}

type ShapeRule = {
  readonly minLength?: number;
  readonly startsWith?: string;
  readonly oneOf?: readonly string[];
  readonly hexLength?: number;
  readonly pemLike?: boolean;
  readonly numeric?: boolean;
};

function checkVar(
  env: NodeJS.ProcessEnv,
  name: string,
  opts: { required: boolean; describe: string; fix: string; shape?: ShapeRule },
): CheckResult {
  const raw = env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return {
      name,
      verdict: opts.required ? "missing" : "optional_missing",
      detail: opts.required ? "not set" : "not set (optional)",
      fix: opts.fix,
    };
  }

  const shape = opts.shape;
  const problems: string[] = [];
  if (shape) {
    if (shape.minLength && value.length < shape.minLength) {
      problems.push(`expected at least ${shape.minLength} characters`);
    }
    if (shape.startsWith && !value.startsWith(shape.startsWith)) {
      problems.push(`expected it to start with "${shape.startsWith}"`);
    }
    if (shape.oneOf && !shape.oneOf.includes(value)) {
      problems.push(`expected one of: ${shape.oneOf.join(", ")}`);
    }
    if (shape.hexLength && !new RegExp(`^[0-9a-fA-F]{${shape.hexLength}}$`).test(value)) {
      problems.push(`expected ${shape.hexLength} hexadecimal characters`);
    }
    if (shape.pemLike && !value.includes("BEGIN") && !value.includes("PRIVATE KEY")) {
      problems.push("expected a PEM private key (should contain BEGIN ... PRIVATE KEY)");
    }
    if (shape.numeric && !/^\d+$/.test(value)) {
      problems.push("expected a numeric id");
    }
  }

  if (problems.length > 0) {
    return {
      name,
      verdict: "malformed",
      detail: `set but ${problems.join("; ")} — value ${fingerprint(value)}`,
      fix: opts.fix,
    };
  }

  return { name, verdict: "ready", detail: `set — ${fingerprint(value)}` };
}

function buildReport(env: NodeJS.ProcessEnv): readonly Capability[] {
  return [
    {
      title: "Per-tenant microVM isolation (Fly Machines)",
      why: "Runs customer repositories in an isolated Machine instead of the shared host.",
      checks: [
        // Either name works; the sandbox-scoped one is preferred (narrower credential).
        env.MENDPOINT_SANDBOX_FLY_TOKEN?.trim()
          ? checkVar(env, "MENDPOINT_SANDBOX_FLY_TOKEN", {
              required: true,
              describe: "sandbox-scoped Fly deploy token (preferred)",
              fix: "Create with: fly tokens create deploy -a mendpoint-sandbox",
              shape: { minLength: 20 },
            })
          : checkVar(env, "FLY_API_TOKEN", {
              required: true,
              describe: "Fly token (MENDPOINT_SANDBOX_FLY_TOKEN preferred - narrower scope)",
              fix: "Create a sandbox-scoped token: fly tokens create deploy -a mendpoint-sandbox, then set it as MENDPOINT_SANDBOX_FLY_TOKEN.",
              shape: { minLength: 20 },
            }),
        checkVar(env, "MENDPOINT_SANDBOX_FLY_APP", {
          required: true,
          describe: "the Fly app that hosts sandbox Machines",
          fix: "Set it to the Fly app name that will host sandbox Machines (e.g. mendpoint-sandbox).",
          shape: { minLength: 3 },
        }),
        checkVar(env, "MENDPOINT_SANDBOX_KIND", {
          required: true,
          describe: "sandbox backend selector",
          fix: 'Set MENDPOINT_SANDBOX_KIND=fly_machines to route runs to the microVM backend.',
          shape: { oneOf: ["fly_machines", "local"] },
        }),
      ],
    },
    {
      title: "Real repository connect (GitHub App)",
      why: "Lets a customer install the App and have their repos cloned on connect.",
      checks: [
        checkVar(env, "GITHUB_APP_ID", {
          required: true,
          describe: "GitHub App id",
          fix: "Copy the App ID from the GitHub App settings page.",
          shape: { numeric: true },
        }),
        checkVar(env, "GITHUB_APP_PRIVATE_KEY", {
          required: true,
          describe: "GitHub App private key (PEM)",
          fix: "Generate a private key in the App settings and set the whole PEM as one secret.",
          shape: { pemLike: true },
        }),
        checkVar(env, "GITHUB_WEBHOOK_SECRET", {
          required: true,
          describe: "webhook signing secret",
          fix: "Set the same value you configured as the App's webhook secret.",
          shape: { minLength: 16 },
        }),
        checkVar(env, "GITHUB_APP_CLIENT_ID", {
          required: false,
          describe: "OAuth client id (only for the user-facing install flow)",
          fix: "Optional: needed only if you use the OAuth install redirect.",
        }),
        checkVar(env, "GITHUB_APP_CLIENT_SECRET", {
          required: false,
          describe: "OAuth client secret",
          fix: "Optional: pairs with GITHUB_APP_CLIENT_ID.",
        }),
        checkVar(env, "GITHUB_MODE", {
          required: true,
          describe: "mock vs real delivery",
          fix: 'Set GITHUB_MODE=real to open real pull requests (mock is the safe default).',
          shape: { oneOf: ["real", "mock"] },
        }),
      ],
    },
    {
      title: "Customer model tier (same Muse API, non-training model)",
      why: "Customer code must never run on a training tier. Same base URL and key; only the model id differs.",
      checks: [
        checkVar(env, "LLM_AGENT_URL", {
          required: true,
          describe: "Muse API base URL",
          fix: "Set the Muse API base URL (shared by both tiers).",
          shape: { startsWith: "http" },
        }),
        checkVar(env, "LLM_AGENT_MODEL", {
          required: true,
          describe: "the configured model id",
          fix: "Set the model id. Internal tenants may use muse-spark-1.2-contributor; customers are routed to muse-spark-1.2.",
          shape: { minLength: 3 },
        }),
        checkVar(env, "MENDPOINT_CUSTOMER_MODEL_ROUTING", {
          required: false,
          describe: "per-tenant tier routing switch",
          fix: 'Set MENDPOINT_CUSTOMER_MODEL_ROUTING=1 before onboarding customers so they are routed to the non-training model.',
          shape: { oneOf: ["1", "0"] },
        }),
        checkVar(env, "MENDPOINT_TRAINING_TIER_TENANTS", {
          required: false,
          describe: "tenants allowed on the training tier",
          fix: "Optional: comma-separated tenant ids permitted to use the contributor (training) tier.",
        }),
      ],
    },
    {
      title: "Billing settlement (payment processor)",
      why: "Turns metered MCU usage into a real charge. Ships mock-only until a processor is wired.",
      checks: [
        checkVar(env, "MENDPOINT_BILLING_COLLECTION", {
          required: false,
          describe: "settlement mode",
          fix: 'Currently only "disabled" and "mock" ship. A real processor adapter is still to be built.',
          shape: { oneOf: ["disabled", "mock"] },
        }),
      ],
    },
    {
      title: "API / web runtime",
      why: "Required for the API to boot and the web app to serve the console.",
      checks: [
        checkVar(env, "MENDPOINT_APPLICATION_DATA_KEY", {
          required: true,
          describe: "encryption key for stored application data",
          fix: "Generate 32 random bytes as 64 hex characters and set it once (rotating it invalidates stored data).",
          shape: { hexLength: 64 },
        }),
        checkVar(env, "MENDPOINT_WEB_ACCESS_TOKEN", {
          required: false,
          describe: "shared preview access token",
          fix: "Only needed for the operator preview gate; self-serve signup replaces it.",
        }),
      ],
    },
    {
      title: "Self-serve feature flags",
      why: "Every self-serve capability ships default-off. These turn them on.",
      checks: [
        checkVar(env, "MENDPOINT_SELF_SERVE_SIGNUP", {
          required: false,
          describe: "public signup + auto tenant provisioning",
          fix: "Set to 1 to allow customers to create their own workspace.",
          shape: { oneOf: ["1", "0"] },
        }),
        checkVar(env, "MENDPOINT_SELF_SERVE_CONNECT", {
          required: false,
          describe: "customer-driven repo connect",
          fix: "Set to 1 to let customers connect repositories themselves.",
          shape: { oneOf: ["1", "0"] },
        }),
        checkVar(env, "MENDPOINT_SELF_SERVE_WARDEN", {
          required: false,
          describe: "tenant spec publishing + scan trigger",
          fix: "Set to 1 to let customers publish specs and trigger their own scans.",
          shape: { oneOf: ["1", "0"] },
        }),
        checkVar(env, "MENDPOINT_SELF_SERVE_BILLING", {
          required: false,
          describe: "metered billing + quota enforcement",
          fix: "Set to 1 to meter real runs and enforce plan quotas.",
          shape: { oneOf: ["1", "0"] },
        }),
        checkVar(env, "MENDPOINT_SELF_SERVE_ADMIN", {
          required: false,
          describe: "access scoping + audit administration",
          fix: "Set to 1 to expose org/team/repo/env access administration.",
          shape: { oneOf: ["1", "0"] },
        }),
      ],
    },
  ];
}

const ICON: Record<Verdict, string> = {
  ready: "OK  ",
  missing: "MISS",
  malformed: "BAD ",
  optional_missing: "--  ",
};

function main(): void {
  const report = buildReport(process.env);
  const lines: string[] = [];
  lines.push("");
  lines.push("Mendpoint external configuration check");
  lines.push("(presence and shape only - no secret value is ever printed)");
  lines.push("");

  let blocking = 0;
  for (const capability of report) {
    const blockingHere = capability.checks.filter(
      (check) => check.verdict === "missing" || check.verdict === "malformed",
    ).length;
    blocking += blockingHere;
    const status = blockingHere === 0 ? "READY" : `${blockingHere} TO FIX`;
    lines.push(`${capability.title} - ${status}`);
    lines.push(`  ${capability.why}`);
    for (const check of capability.checks) {
      lines.push(`  ${ICON[check.verdict]} ${check.name}: ${check.detail}`);
      if (check.fix && (check.verdict === "missing" || check.verdict === "malformed")) {
        lines.push(`         fix: ${check.fix}`);
      }
    }
    lines.push("");
  }

  if (blocking === 0) {
    lines.push("All required settings are present and plausibly shaped.");
  } else {
    lines.push(`${blocking} setting(s) still need attention - see the "fix:" lines above.`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

main();
