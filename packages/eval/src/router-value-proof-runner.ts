import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ROUTER_VALUE_PROOF_VERSION,
  evaluateRouterValueProof,
  type RouterValueObservation,
  type RouterValueProofContract,
  type RouterValueProofReport,
} from "./router-value-proof.js";

export type RouterValueProofInput = Readonly<{
  version: typeof ROUTER_VALUE_PROOF_VERSION;
  cohort: Readonly<{
    id: string;
    revision: string;
    heldOut: boolean;
  }>;
  policy: RouterValueProofContract["policy"];
  observations: readonly RouterValueObservation[];
}>;

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function runRouterValueProofArtifact(inputPath: string): RouterValueProofReport {
  const raw = readFileSync(inputPath);
  let input: RouterValueProofInput;
  try {
    input = JSON.parse(raw.toString("utf8")) as RouterValueProofInput;
  } catch {
    throw new Error("router_value_input_invalid");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("router_value_input_invalid");
  }
  return evaluateRouterValueProof({
    ...input,
    cohort: { ...input.cohort, digest: digest(raw) },
    observations: [...input.observations],
  });
}

export function persistRouterValueProofReport(
  inputPath: string,
  outputPath: string,
): RouterValueProofReport {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error("router_value_output_must_differ");
  if (existsSync(output)) throw new Error("router_value_output_exists");
  const report = runRouterValueProofArtifact(input);
  const temporary = resolve(dirname(output), `.${randomUUID()}.router-value.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return report;
}
