import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export const ROUTER_VALUE_INPUT_MAX_BYTES = 5 * 1024 * 1024;

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function runRouterValueProofArtifact(inputPath: string): RouterValueProofReport {
  const inputFile = resolve(inputPath);
  let stat;
  try {
    stat = lstatSync(inputFile);
  } catch {
    throw new Error("router_value_input_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("router_value_input_not_regular");
  if (stat.size < 1 || stat.size > ROUTER_VALUE_INPUT_MAX_BYTES) {
    throw new Error("router_value_input_size_invalid");
  }
  const raw = readFileSync(inputFile);
  if (raw.length < 1 || raw.length > ROUTER_VALUE_INPUT_MAX_BYTES) {
    throw new Error("router_value_input_size_invalid");
  }
  let input: RouterValueProofInput;
  try {
    input = JSON.parse(raw.toString("utf8")) as RouterValueProofInput;
  } catch {
    throw new Error("router_value_input_invalid");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("router_value_input_invalid");
  }
  if (!Array.isArray(input.observations)) throw new Error("router_value_observations_required");
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
    // A hard-link publication is both atomic and create-only. renameSync would
    // overwrite a destination created after the existsSync preflight.
    linkSync(temporary, output);
    rmSync(temporary);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return report;
}
