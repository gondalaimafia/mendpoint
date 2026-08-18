/**
 * Failure -> eval: the redaction / governance gate.
 *
 * A validated failure is not automatically safe to commit. If it was found on a
 * real customer repository, its reproduction could carry proprietary code,
 * secrets, or PII, and committing it into a public regression suite would leak
 * exactly the data the product is trusted to protect. This gate is the one place
 * that decides whether a `RegressionCase` may enter the committed suite, and it
 * refuses anything it cannot certify:
 *
 *   1. Data provenance. Only `synthetic` content, or content explicitly
 *      `redacted-from-customer` WITH a redaction reference, is admissible. A case
 *      that claims customer data is present (`containsCustomerData` other than
 *      `false`) is rejected outright.
 *   2. Answer-key isolation. The reproducing repo must contain no grading-key
 *      file — the same invariant `runners/stage.ts` enforces at run time — so a
 *      generated regression repo can never smuggle its own answer key onto disk
 *      where an LLM-enabled product could read it.
 *
 * The gate throws (rather than filtering silently) so a case that fails
 * governance fails LOUDLY at suite-build time instead of quietly disappearing.
 */
import { isAnswerKeyFile } from "../runners/stage.js";
import { validateRegressionCase, type RegressionCase } from "./schema.js";

export class RegressionGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressionGovernanceError";
  }
}

/**
 * Assert a case is admissible into the committed suite. Returns void on success
 * so callers can assert-and-continue. Throws `RegressionGovernanceError` with a
 * precise reason otherwise.
 */
export function assertAdmissible(c: RegressionCase): void {
  const shape = validateRegressionCase(c);
  if (shape.length) {
    throw new RegressionGovernanceError(
      `regression case ${c.id ?? "(no id)"} is malformed:\n  - ${shape.join("\n  - ")}`,
    );
  }

  const g = c.governance;
  if (!g || typeof g !== "object") {
    throw new RegressionGovernanceError(`regression case ${c.id}: missing governance block`);
  }
  // `containsCustomerData` is typed `false`, but a hand-authored case (or a JSON
  // round-trip) could still carry a truthy value; refuse it at runtime too.
  if ((g.containsCustomerData as unknown) !== false) {
    throw new RegressionGovernanceError(
      `regression case ${c.id}: containsCustomerData must be certified false before it can be committed`,
    );
  }
  if (g.dataProvenance === "redacted-from-customer" && !g.redactionRef) {
    throw new RegressionGovernanceError(
      `regression case ${c.id}: a redacted-from-customer case must reference its redaction record (redactionRef)`,
    );
  }
  if (g.dataProvenance !== "synthetic" && g.dataProvenance !== "redacted-from-customer") {
    throw new RegressionGovernanceError(
      `regression case ${c.id}: dataProvenance must be synthetic|redacted-from-customer (got '${g.dataProvenance}')`,
    );
  }
  if (typeof g.rationale !== "string" || !g.rationale.length) {
    throw new RegressionGovernanceError(
      `regression case ${c.id}: governance.rationale must explain why the case is safe to commit`,
    );
  }

  // Answer-key isolation: no grading key may exist in the reproducing repo.
  const repro = c.build();
  const keyFiles = Object.keys(repro.repo.files).filter((p) => isAnswerKeyFile(p));
  if (keyFiles.length) {
    throw new RegressionGovernanceError(
      `regression case ${c.id}: reproducing repo contains answer-key file(s) that would leak to the product: ${keyFiles.join(", ")}`,
    );
  }
}
