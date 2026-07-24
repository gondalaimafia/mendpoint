/**
 * Verify script — exit 0 when path typo is fixed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "client.js"), "utf8");

const errors = [];
if (src.includes("chargess")) {
  errors.push("API path still has typo chargess");
}
if (!src.includes("/v1/charges")) {
  errors.push("missing correct path /v1/charges");
}

if (errors.length) {
  console.error("FAIL:\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exit(1);
}
console.log("OK: path typo fixed");
process.exit(0);
