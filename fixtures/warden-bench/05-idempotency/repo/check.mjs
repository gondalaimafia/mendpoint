/**
 * Verify script — exit 0 when Idempotency-Key header is set on the POST.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "pay.js"), "utf8");

// Require a real header key in code (quoted), not merely the phrase in a comment.
const hasHeader =
  /["']Idempotency-Key["']\s*:/.test(src) ||
  /["']idempotency-key["']\s*:/.test(src);

const errors = [];
if (!hasHeader) {
  errors.push('POST still missing "Idempotency-Key" header entry');
}
if (!/method:\s*["']POST["']/i.test(src)) {
  errors.push("expected a POST request");
}

if (errors.length) {
  console.error("FAIL:\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exit(1);
}
console.log("OK: Idempotency-Key header present");
process.exit(0);
