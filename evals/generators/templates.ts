/**
 * Seeded synthetic-repository templates.
 *
 * A template builds a healthy, executable-shaped TypeScript service whose import
 * topology and distractor placement are driven by a seed, so one family can emit
 * many genuinely-different repositories (used for the validation/holdout splits
 * without hand-authoring each one). The template also declares the ROLE of every
 * file it plants (impacted / decoy / generated / vendored), which the mutation
 * engine turns into a correct-by-construction answer key.
 *
 * The topology mirrors the pattern the real Fettler path resolves (verified
 * empirically): a provider-client ANCHOR that imports the provider package,
 * impacted files reachable from it through RELATIVE imports that carry the
 * provider field, and decoys that use the same token in an unrelated context and
 * never reach the anchor (so the provenance gate demotes them).
 */
import { mulberry32, type SyntheticRepo } from "../mutations/engine.js";

export interface TemplateRoles {
  /** Files that carry the provider field and must be flagged on a rename. */
  impacted: string[];
  /** Files with the same token in an unrelated context — must NOT be flagged. */
  decoys: string[];
  /** Header-marked generated files carrying the token — must NOT be flagged. */
  generated: string[];
  /** Vendored SDK files carrying the token — must NOT be flagged. */
  vendored: string[];
  /**
   * Files that LOOK generated (live under generated/, but no @generated header)
   * yet are hand source carrying the token — these MUST be flagged.
   */
  looksGenerated: string[];
}

export interface TemplateResult {
  repo: SyntheticRepo;
  roles: TemplateRoles;
  slug: string;
  field: string;
  path: string;
  method: string;
}

export interface TemplateOptions {
  seed: number;
  /** Provider package name; also the Fettler runner `slug`. */
  slug?: string;
  /** The provider field name (v1). */
  field?: string;
  /** Include a header-marked generated file that carries the field (a trap). */
  withGenerated?: boolean;
  /** Include a provenance-backed vendored SDK file that carries the field. */
  withVendored?: boolean;
  /** Include a looks-generated-but-hand-written file that carries the field (must be flagged). */
  withLooksGenerated?: boolean;
}

const DECOY_BUILDERS: ReadonlyArray<(field: string) => { path: string; content: string }> = [
  (field) => ({
    path: "src/analytics/tracker.ts",
    content: `// Analytics event origin — unrelated to the provider payment field.\nexport interface AnalyticsEvent {\n  ${field}: string;\n  ts: number;\n}\nexport function track(e: AnalyticsEvent): string {\n  return e.${field};\n}\n`,
  }),
  (field) => ({
    path: "src/config/constants.ts",
    content: `// The event ${field} here names an internal subsystem, not a payment token.\nexport const SETTINGS = {\n  ${field}: "internal-config",\n  region: "us-east-1",\n};\n`,
  }),
  (field) => ({
    path: "src/importer/records.ts",
    content: `// Origin system of an imported row; internal type, never sent to the provider.\nexport interface ImportRecord {\n  id: string;\n  ${field}: string;\n}\nexport function originOf(r: ImportRecord): string {\n  return r.${field};\n}\n`,
  }),
  (field) => ({
    path: "src/inventory/service.ts",
    content: `// Inventory transfer prose mentioning a ${field} warehouse — not payments.\nexport function transfer(from: string, to: string): string {\n  return \`moved from ${field} warehouse \${from} to \${to}\`;\n}\n`,
  }),
];

/** Build a seeded TypeScript payments service and declare every file's role. */
export function tsPaymentsService(opts: TemplateOptions): TemplateResult {
  const rng = mulberry32(opts.seed);
  const slug = opts.slug ?? "meridian";
  const field = opts.field ?? "source";
  const ProviderClass = slug.charAt(0).toUpperCase() + slug.slice(1);
  const path = "/v1/charges";
  const method = "POST";

  const files: Record<string, string> = {};
  const impacted: string[] = [];
  const decoys: string[] = [];
  const generated: string[] = [];
  const vendored: string[] = [];
  const looksGenerated: string[] = [];

  files["package.json"] =
    JSON.stringify(
      { name: `synthetic-${slug}-svc`, private: true, dependencies: { [slug]: "^1.0.0" } },
      null,
      2,
    ) + "\n";
  files["README.md"] = `# synthetic-${slug}-svc\n\nA synthetic payments service (generated for evaluation).\n`;

  // Anchor: imports the provider package, declares the request type + field.
  const client = "src/infra/provider/client.ts";
  files[client] = `import { ${ProviderClass} } from "${slug}";

export interface ProviderChargeRequest {
  amount: number;
  ${field}: string;
}

const client = new ${ProviderClass}();

export async function createCharge(req: ProviderChargeRequest): Promise<{ id: string }> {
  return client.charges.create({ amount: req.amount, ${field}: req.${field} });
}
`;
  impacted.push(client);

  // Impacted services (1..3), each importing the client via a relative path.
  const serviceCount = 1 + Math.floor(rng() * 3);
  const serviceNames = ["checkoutService", "subscriptionService", "settlementService"];
  for (let i = 0; i < serviceCount; i++) {
    const name = serviceNames[i] ?? `service${i}`;
    const p = `src/services/${name}.ts`;
    files[p] = `import { createCharge, type ProviderChargeRequest } from "../infra/provider/client.js";

export async function ${name.replace("Service", "")}(amount: number, ${field}: string): Promise<{ id: string }> {
  const req: ProviderChargeRequest = { amount, ${field} };
  return createCharge(req);
}
`;
    impacted.push(p);
  }

  // Impacted fixture (imports the request type, carries the field on the wire).
  const fixture = "test/fixtures/charges.ts";
  files[fixture] = `import type { ProviderChargeRequest } from "../../src/infra/provider/client.js";

export const chargeFixture: ProviderChargeRequest = {
  amount: 1000,
  ${field}: "pm_card_visa",
};
`;
  impacted.push(fixture);

  // Decoys (2..4): unrelated uses of the token, never importing the provider.
  const decoyCount = 2 + Math.floor(rng() * 3);
  const order = [...DECOY_BUILDERS].sort(() => rng() - 0.5);
  for (let i = 0; i < decoyCount && i < order.length; i++) {
    const { path: p, content } = order[i]!(field);
    files[p] = content;
    decoys.push(p);
  }

  if (opts.withGenerated) {
    const p = "src/generated/apiTypes.ts";
    files[p] = `/* @generated by openapi-generator — DO NOT EDIT. */
export interface GeneratedChargeRequest {
  amount: number;
  ${field}: string;
}
`;
    generated.push(p);
  }

  if (opts.withVendored) {
    const p = "vendor/provider-sdk/index.ts";
    files["vendor/provider-sdk/package.json"] =
      JSON.stringify(
        { name: "provider-sdk-copy", version: "1.0.0", private: false },
        null,
        2,
      ) + "\n";
    files[p] = `import { ${ProviderClass} } from "${slug}";
// Vendored copy of the provider SDK. Regenerated from upstream; not ours to edit.
export function charge(client: ${ProviderClass}, amount: number, ${field}: string) {
  return client.charges.create({ amount, ${field} });
}
`;
    files["src/vendorProvider.ts"] =
      'export { charge as vendoredCharge } from "../vendor/provider-sdk/index.js";\n';
    vendored.push(p);
  }

  if (opts.withLooksGenerated) {
    // Lives under generated/ but has NO @generated header -> hand source -> must flag.
    const p = "src/generated/handMaintained.ts";
    files[p] = `import { createCharge, type ProviderChargeRequest } from "../infra/provider/client.js";
// This file lives under generated/ but is hand-maintained (no codegen header).
export async function replay(amount: number, ${field}: string) {
  const req: ProviderChargeRequest = { amount, ${field} };
  return createCharge(req);
}
`;
    looksGenerated.push(p);
    impacted.push(p);
  }

  return {
    repo: { files },
    roles: { impacted, decoys, generated, vendored, looksGenerated },
    slug,
    field,
    path,
    method,
  };
}
