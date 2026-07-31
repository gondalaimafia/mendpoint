import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

for (const file of ["./src/payments.ts", "./src/checkout.ts"]) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const runnable = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/^import .*;$/gm, "")
    .replace(/\bexport\s+/g, "");
  new Function(runnable);
}

const payments = await readFile(new URL("./src/payments.ts", import.meta.url), "utf8");
const checkout = await readFile(new URL("./src/checkout.ts", import.meta.url), "utf8");
for (const symbol of ["chargeCustomer", "fetchReceipt", "acmeChargesCreate"]) {
  assert.match(payments, new RegExp(`\\b${symbol}\\b`));
}
for (const symbol of [
  "PaymentService_charge",
  "PaymentService_receipt",
  "handleCheckout",
]) {
  assert.match(checkout, new RegExp(`\\b${symbol}\\b`));
}

console.log("Shop app module verification passed");
