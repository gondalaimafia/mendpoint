/**
 * Verify script — exit 0 when http://api. upgraded to https://api.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "client.js"), "utf8");

const errors = [];
if (src.includes("http://api.")) {
  errors.push("still using http://api. — must use https");
}
if (!src.includes("https://api.")) {
  errors.push("missing https://api. base URL");
}

if (errors.length) {
  console.error("FAIL:\n" + errors.map((e) => ` - ${e}`).join("\n"));
  process.exit(1);
}
console.log("OK: HTTPS upgrade applied");
process.exit(0);
