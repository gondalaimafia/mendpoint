/**
 * Known vendor catalog — maps package / import signals → API provider slug.
 * Phase C: auto-detect from lockfiles and source imports.
 */
export type VendorEntry = {
  slug: string;
  name: string;
  website?: string;
  /** npm package names */
  npm: string[];
  /** Python package / import roots (pip name or top-level module) */
  pypi: string[];
  /** Optional public OpenAPI / changelog feed URL (for continuous intake) */
  openapiUrl?: string;
  changelogUrl?: string;
  /** Tokens useful for impact search */
  defaultSearchTokens: string[];
};

export const VENDOR_CATALOG: VendorEntry[] = [
  {
    slug: "stripe",
    name: "Stripe",
    website: "https://stripe.com/docs/api",
    npm: ["stripe", "@stripe/stripe-js"],
    pypi: ["stripe"],
    // Public OpenAPI is not stable; override via DB provider.openapi_url or env.
    openapiUrl: process.env.STRIPE_OPENAPI_URL,
    changelogUrl: "https://stripe.com/docs/upgrades",
    defaultSearchTokens: ["stripe", "customers.list", "starting_after", "/v1/"],
  },
  {
    slug: "openai",
    name: "OpenAI",
    website: "https://platform.openai.com/docs",
    npm: ["openai"],
    pypi: ["openai"],
    openapiUrl: process.env.OPENAI_OPENAPI_URL,
    changelogUrl: "https://platform.openai.com/docs/changelog",
    defaultSearchTokens: ["openai", "chat.completions", "max_tokens", "max_completion_tokens"],
  },
  {
    slug: "aws-sdk",
    name: "AWS SDK (S3)",
    website: "https://docs.aws.amazon.com/sdk-for-javascript/",
    npm: ["aws-sdk", "@aws-sdk/client-s3", "@aws-sdk/client-sts"],
    pypi: ["boto3", "botocore"],
    defaultSearchTokens: ["AWS.S3", "S3Client", "getObject", "boto3"],
  },
  {
    slug: "acme-payments",
    name: "Acme Payments",
    website: "https://acme-payments.example",
    npm: ["@acme/payments", "acme-payments"],
    pypi: ["acme-payments"],
    // Local fixture feed — worker resolves monorepo-relative file: URLs
    openapiUrl: "file:fixtures/providers/acme-payments/openapi-v2.json",
    changelogUrl: "file:fixtures/providers/acme-payments/changelog.md",
    defaultSearchTokens: ["amount_cents", "/v1/charges", "acme"],
  },
  {
    slug: "payments-api",
    name: "Payments API (internal)",
    npm: ["@internal/payments-api", "payments-api"],
    pypi: ["payments-api"],
    defaultSearchTokens: ["/v2/transfers", "X-API-Key", "idempotency_key"],
  },
  {
    slug: "twilio",
    name: "Twilio",
    website: "https://www.twilio.com/docs",
    npm: ["twilio"],
    pypi: ["twilio"],
    openapiUrl: process.env.TWILIO_OPENAPI_URL,
    defaultSearchTokens: ["twilio", "messages.create"],
  },
  {
    slug: "github",
    name: "GitHub API",
    website: "https://docs.github.com/en/rest",
    npm: ["@octokit/rest", "@octokit/core", "octokit"],
    pypi: ["PyGithub", "github"],
    // GitHub publishes REST OpenAPI descriptions
    openapiUrl:
      process.env.GITHUB_OPENAPI_URL ??
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    changelogUrl: "https://docs.github.com/en/rest/overview/api-versions",
    defaultSearchTokens: ["octokit", "github.rest"],
  },
];

export function findVendorByPackage(
  pkg: string,
  ecosystem: "npm" | "pypi",
): VendorEntry | undefined {
  const lower = pkg.toLowerCase();
  return VENDOR_CATALOG.find((v) => {
    const list = ecosystem === "npm" ? v.npm : v.pypi;
    return list.some((p) => p.toLowerCase() === lower || lower.startsWith(p.toLowerCase() + "/"));
  });
}

export function listCatalog() {
  return VENDOR_CATALOG.map((v) => ({
    slug: v.slug,
    name: v.name,
    website: v.website ?? null,
    npm: v.npm,
    pypi: v.pypi,
    openapiUrl: v.openapiUrl ?? null,
    changelogUrl: v.changelogUrl ?? null,
  }));
}
