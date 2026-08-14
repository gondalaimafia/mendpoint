/**
 * Example-specific deterministic migrations (production generators would
 * be driven by e-graph extraction + style matching).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ChangeEvent } from "./types.js";
import type { ImpactFinding } from "@mendpoint/shared";

export type FileEdit = { path: string; original: string; updated: string };

function readConsumerFiles(consumerRoot: string): Array<{ rel: string; abs: string; text: string }> {
  const out: Array<{ rel: string; abs: string; text: string }> = [];
  const walk = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else if (/\.(ts|js|py)$/.test(name)) {
        out.push({ rel: rel.replace(/\\/g, "/"), abs, text: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(consumerRoot);
  return out;
}

/**
 * The transform families this demo rewriter knows how to apply. Selection is
 * driven by the *described change* (its `ops`, `searchTokens`, `egraphRules`,
 * `sdkSurface`) — never by the vendor's name. A vendor we have never seen still
 * selects the right family when its change carries the same shape, and a change
 * whose shape we do not recognize abstains explicitly instead of silently
 * selecting nothing.
 */
export type SdkTransformFamily =
  | "stripe-cursor-pagination"
  | "openai-token-rename"
  | "aws-s3-modular"
  | "http-bearer-idempotency";

function hasToken(ev: ChangeEvent, test: (token: string) => boolean): boolean {
  return (ev.searchTokens ?? []).some(test);
}

function opsMatch(
  ev: ChangeEvent,
  test: (op: ChangeEvent["ops"][number]) => boolean,
): boolean {
  return (ev.ops ?? []).some(test);
}

export function selectSdkTransformFamilies(ev: ChangeEvent): SdkTransformFamily[] {
  const families: SdkTransformFamily[] = [];
  const egraph = new Set(ev.egraphRules ?? []);
  const surface = (ev.sdkSurface ?? "").toLowerCase();

  // Cursor / auto-paging: the change renames or deprecates an offset/cursor
  // field or advertises an auto-paging helper. Matched on the pagination tokens
  // and rename ops, tolerant of snake_case and camelCase field spellings.
  if (
    hasToken(ev, (t) => /^starting_?after$/i.test(t) || /^has_more$/i.test(t) || /autopaging/i.test(t)) ||
    opsMatch(ev, (o) => /starting_?after/i.test(o.fromField ?? "") || /starting_?after/i.test(o.field ?? "")) ||
    egraph.has("prefer_auto_paging") ||
    egraph.has("legacy_page_to_cursor")
  ) {
    families.push("stripe-cursor-pagination");
  }

  // Token field rename: `max_tokens` → `max_completion_tokens` (plus the
  // `choices[].text` → `message.content` response move).
  if (
    opsMatch(ev, (o) => o.op === "request_field_renamed" && o.fromField === "max_tokens") ||
    hasToken(ev, (t) => t.toLowerCase() === "max_tokens")
  ) {
    families.push("openai-token-rename");
  }

  // AWS SDK v2 monolith → modular v3 client.
  if (
    surface.startsWith("aws.s3") ||
    hasToken(ev, (t) => /^aws-sdk$/i.test(t) || /^aws\.s3$/i.test(t) || /^new aws$/i.test(t)) ||
    opsMatch(ev, (o) => (o.path ?? "").startsWith("AWS.S3") || (o.path ?? "") === "S3Client")
  ) {
    families.push("aws-s3-modular");
  }

  // HTTP header auth swap + required idempotency key.
  if (
    opsMatch(ev, (o) => o.op === "security_changed") ||
    opsMatch(ev, (o) => o.op === "request_field_added_required" && o.field === "idempotency_key") ||
    hasToken(ev, (t) => /^x-api-key$/i.test(t) || t.toLowerCase() === "idempotency_key")
  ) {
    families.push("http-bearer-idempotency");
  }

  return families;
}

export type ExampleMigrationResult =
  | Readonly<{ status: "edits"; families: readonly SdkTransformFamily[]; edits: FileEdit[] }>
  | Readonly<{ status: "no_changes"; families: readonly SdkTransformFamily[]; edits: readonly [] }>
  | Readonly<{ status: "abstained"; reason: string; families: readonly []; edits: readonly [] }>;

/**
 * Resolve a change event to a concrete migration plan. When the change matches
 * no known transform family this returns an explicit `abstained` result carrying
 * a reason — it never falls through to a silent empty edit list that reads as
 * "nothing to do".
 */
export function planExampleMigration(
  ev: ChangeEvent,
  consumerRoot: string,
  findings: ImpactFinding[],
): ExampleMigrationResult {
  const families = selectSdkTransformFamilies(ev);
  if (!families.length) {
    const subject = ev.sdkSurface || ev.vendor || ev.id || "unknown";
    return {
      status: "abstained",
      reason: `no_sdk_transform_for_change:${subject}`,
      families: [],
      edits: [],
    };
  }
  const edits = applyFamilyTransforms(ev, families, consumerRoot, findings);
  return edits.length
    ? { status: "edits", families, edits }
    : { status: "no_changes", families, edits: [] };
}

export function generateExampleEdits(
  ev: ChangeEvent,
  consumerRoot: string,
  findings: ImpactFinding[],
): FileEdit[] {
  const plan = planExampleMigration(ev, consumerRoot, findings);
  return plan.status === "edits" ? plan.edits : [];
}

function applyFamilyTransforms(
  ev: ChangeEvent,
  families: readonly SdkTransformFamily[],
  consumerRoot: string,
  _findings: ImpactFinding[],
): FileEdit[] {
  const files = readConsumerFiles(consumerRoot);
  const edits: FileEdit[] = [];

  for (const f of files) {
    let updated = f.text;

    if (
      families.includes("stripe-cursor-pagination") &&
      (updated.includes("starting_after") || updated.includes("customers.list"))
    ) {
      // Direct list calls → autoPagingToArray
      updated = updated.replace(
        /await stripe\.customers\.list\(\{\s*limit:\s*(\d+),\s*starting_after:[^}]+\}\)/g,
        `await stripe.customers.list({ limit: $1 }).autoPagingToArray({ limit: 1000 })`,
      );
      // Infinite for-loop pagination body
      if (updated.includes("for (;;)") && updated.includes("starting_after")) {
        updated = updated.replace(
          /const all: Stripe\.Customer\[\] = \[\];\s*let lastCustomerId: string \| undefined;\s*for \(;;\) \{[\s\S]*?return all;/,
          `// mendpoint: migrated manual starting_after loop → auto-paging
  const page = await stripe.customers.list({ limit: 100 });
  return page.autoPagingToArray({ limit: 10000 });`,
        );
      }
      // do/while has_more loop
      if (updated.includes("do {") && updated.includes("has_more")) {
        updated = updated.replace(
          /const out: Stripe\.Customer\[\] = \[\];\s*let starting_after: string \| undefined;\s*do \{[\s\S]*?\} while \(starting_after\);\s*return out;/,
          `// mendpoint: optional adoption of auto-paging helper
  const page = await stripe.customers.list({ limit: 50 });
  return page.autoPagingToArray({ limit: 10000 });`,
        );
      }
    }


    if (families.includes("openai-token-rename")) {
      updated = updated.replace(/\bmax_tokens\s*=/g, "max_completion_tokens=");
      updated = updated.replace(
        /response\.choices\[0\]\.text/g,
        "response.choices[0].message.content",
      );
    }

    if (families.includes("aws-s3-modular")) {
      if (updated.includes("aws-sdk") || updated.includes("AWS.S3")) {
        updated = `import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "us-east-1" });

async function streamToString(stream: AsyncIterable<Uint8Array> | ReadableStream | NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

${updated
  .replace(/import AWS from ["']aws-sdk["'];?\n?/g, "")
  .replace(/const s3 = new AWS\.S3\(\{ region: ["'][^"']+["'] \}\);?\n?/g, "")
  .replace(
    /const data = await s3\.getObject\(\{ Bucket, Key \}\)\.promise\(\);\s*const content = data\.Body\.toString\(\);/g,
    `const data = await s3.send(new GetObjectCommand({ Bucket, Key }));
  const content = await streamToString(data.Body as AsyncIterable<Uint8Array>);`,
  )
  .replace(
    /const data = await s3\.getObject\(\{ Bucket, Key \}\)\.promise\(\);\s*return Buffer\.from\(data\.Body\)\.toString\("base64"\);/g,
    `const data = await s3.send(new GetObjectCommand({ Bucket, Key }));
  const text = await streamToString(data.Body as AsyncIterable<Uint8Array>);
  return Buffer.from(text).toString("base64");`,
  )}`;
      }
    }

    if (families.includes("http-bearer-idempotency")) {
      updated = updated.replace(
        /"X-API-Key":\s*key/g,
        '"Authorization": `Bearer ${key}`',
      );
      updated = updated.replace(
        /"X-API-Key":\s*key,/g,
        '"Authorization": `Bearer ${key}`,',
      );
      // inject idempotency_key into JSON bodies for transfers
      if (updated.includes("/v2/transfers") && updated.includes("JSON.stringify")) {
        updated = updated.replace(
          /JSON\.stringify\(\{\s*amount,\s*currency,\s*destination\s*\}\)/g,
          `JSON.stringify({ amount, currency, destination, idempotency_key: crypto.randomUUID() /* required by payments-api v2 */ })`,
        );
        updated = updated.replace(
          /JSON\.stringify\(\{\s*amount,\s*currency:\s*"usd",\s*destination:\s*"acct_1"\s*\}\)/g,
          `JSON.stringify({ amount, currency: "usd", destination: "acct_1", idempotency_key: crypto.randomUUID() })`,
        );
      }
    }

    if (updated !== f.text) {
      edits.push({ path: f.rel, original: f.text, updated });
    }
  }

  return edits;
}

export function writeEdits(
  outDir: string,
  edits: FileEdit[],
): void {
  for (const e of edits) {
    const target = join(outDir, e.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.updated, "utf8");
  }
}

export function unifiedPatch(edits: FileEdit[]): string {
  const parts: string[] = [];
  for (const e of edits) {
    const a = e.original.split(/\r?\n/);
    const b = e.updated.split(/\r?\n/);
    parts.push(`--- a/${e.path}\n+++ b/${e.path}\n@@ migration @@`);
    for (const line of a) parts.push(`-${line}`);
    for (const line of b) parts.push(`+${line}`);
  }
  return parts.join("\n");
}
