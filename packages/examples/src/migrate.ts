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

export function generateExampleEdits(
  ev: ChangeEvent,
  consumerRoot: string,
  _findings: ImpactFinding[],
): FileEdit[] {
  const files = readConsumerFiles(consumerRoot);
  const edits: FileEdit[] = [];

  for (const f of files) {
    let updated = f.text;
    const id = ev.id;

    if (
      (id.includes("stripe") || id.includes("pagination") || id.includes("feature-adoption")) &&
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


    if (id.includes("openai")) {
      updated = updated.replace(/\bmax_tokens\s*=/g, "max_completion_tokens=");
      updated = updated.replace(
        /response\.choices\[0\]\.text/g,
        "response.choices[0].message.content",
      );
    }

    if (id.includes("aws-s3") || id.includes("s3-v3")) {
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

    if (id.includes("fintech") || id.includes("transfers") || id.includes("payments-api")) {
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
