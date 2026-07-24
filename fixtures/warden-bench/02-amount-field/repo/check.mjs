/**
 * Verify script — exit 0 when amount_cents renamed to amount.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "client.js"), "utf8");

const errors = [];
if (/\bamount_cents\b/.test(src)) {
  errors.push("field amount_cents still present — should be amount");
}
if (!src.includes("amount")) {
  errors.push("missing amount field");
}

if (errors.length) {
  console.error("FAIL:\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exit(1);
}
console.log("OK: amount field renamed");
process.exit(0);
