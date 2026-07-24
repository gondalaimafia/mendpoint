/**
 * Verify script — exit 0 when max_tokens → max_completion_tokens.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "sdk.js"), "utf8");

const errors = [];
if (/\bmax_tokens\b/.test(src)) {
  errors.push("max_tokens still present — use max_completion_tokens");
}
if (!src.includes("max_completion_tokens")) {
  errors.push("missing max_completion_tokens");
}

if (errors.length) {
  console.error("FAIL:\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exit(1);
}
console.log("OK: max_tokens renamed");
process.exit(0);
