import { createHash } from "node:crypto";
import type { ImmutableRepositorySnapshot, RepositoryDiscovery } from "./repository-source.js";

export type CiRunEvidence = Readonly<{
  provider: string;
  workflowPath: string;
  runId: string;
  exactCommit: string;
  conclusion: "success" | "failure" | "cancelled" | "skipped";
  observedAt: string;
  verificationCommands: readonly string[];
}>;

export type ExecutableTargetEvidence = Readonly<{
  version: 1;
  tenantId: string;
  repositoryId: string;
  snapshotSha256: string;
  exactCommit: string;
  targetPaths: readonly string[];
  ownersByPath: Readonly<Record<string, readonly string[]>>;
  ciRun: CiRunEvidence | null;
  discoveredVerificationCommands: readonly string[];
  executable: boolean;
  reasons: readonly string[];
  evidenceSha256: string;
  evaluatedAt: string;
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function required(name: string, value: string): string {
  if (!value.trim()) throw new Error(`${name}_required`);
  return value.trim();
}

function exactObjectId(name: string, value: string): string {
  const normalized = required(name, value).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized)) {
    throw new Error(`${name}_invalid`);
  }
  return normalized;
}

function exactSha256(name: string, value: string): string {
  const normalized = required(name, value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${name}_invalid`);
  return normalized;
}
function timestamp(name: string, value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name}_invalid`);
  return new Date(value).toISOString();
}
function normalizePath(path: string): string {
  const value = required("execution_target_path", path).replace(/\\/g, "/");
  if (value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("execution_target_path_unsafe");
  return value;
}

function matchesCodeowners(patternInput: string, path: string): boolean {
  let pattern = patternInput.trim();
  if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) return false;
  pattern = pattern.replace(/^\//, "");
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!pattern.includes("/")) return path.split("/").includes(pattern.replace(/\*/g, "")) || new RegExp(`^(?:.*/)?${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(path);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}${pattern.includes(".") ? "" : "(?:/.*)?"}$`).test(path);
}

function ownersForPath(discovery: RepositoryDiscovery, path: string): string[] {
  let owners: string[] = [];
  for (const document of discovery.codeowners) {
    for (const line of document.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [pattern, ...candidateOwners] = trimmed.split(/\s+/);
      if (pattern && candidateOwners.length && matchesCodeowners(pattern, path)) owners = candidateOwners.filter((owner) => owner.startsWith("@"));
    }
  }
  return [...new Set(owners)].sort();
}

/**
 * Bind snapshot discovery and a completed CI run before a target may become
 * executable. This function does not execute source code or call an SCM.
 */
export function evaluateExecutableTarget(input: Readonly<{
  tenantId: string;
  snapshot: ImmutableRepositorySnapshot;
  discovery: RepositoryDiscovery;
  targetPaths: readonly string[];
  ciRun?: CiRunEvidence | null;
  evaluatedAt: string;
}>): ExecutableTargetEvidence {
  const tenantId = required("execution_tenant_id", input.tenantId);
  const evaluatedAt = timestamp("execution_evaluated_at", input.evaluatedAt);
  const exactCommit = exactObjectId("execution_exact_commit", input.snapshot.sha);
  const snapshotSha256 = exactSha256("execution_snapshot_sha256", input.snapshot.manifestSha256);
  if (!input.targetPaths.length) throw new Error("execution_target_paths_required");
  const targetPaths = [...new Set(input.targetPaths.map(normalizePath))].sort();
  const snapshotPaths = new Set(input.snapshot.files.map((file) => file.path));
  const ownersByPath = Object.fromEntries(targetPaths.map((path) => [path, Object.freeze(ownersForPath(input.discovery, path))]));
  const reasons = new Set<string>();
  if (targetPaths.some((path) => !snapshotPaths.has(path))) reasons.add("target_not_in_snapshot");
  if (targetPaths.some((path) => ownersByPath[path]!.length === 0)) reasons.add("owner_evidence_missing");
  if (!input.discovery.ci.length) reasons.add("ci_configuration_missing");
  if (!input.discovery.verificationCommands.length) reasons.add("verification_command_missing");
  const ciRun = input.ciRun ?? null;
  if (!ciRun) reasons.add("successful_ci_evidence_missing");
  else {
    timestamp("execution_ci_observed_at", ciRun.observedAt);
    const ciCommit = exactObjectId("execution_ci_exact_commit", ciRun.exactCommit);
    if (ciCommit !== exactCommit) reasons.add("ci_commit_mismatch");
    if (ciRun.conclusion !== "success") reasons.add("ci_not_successful");
    if (!input.discovery.ci.some((config) => config.path === ciRun.workflowPath && config.provider === ciRun.provider)) reasons.add("ci_workflow_not_discovered");
    const discoveredCommands = new Set(input.discovery.verificationCommands.map((command) => command.command));
    if (!ciRun.verificationCommands.length || ciRun.verificationCommands.some((command) => !discoveredCommands.has(command))) reasons.add("ci_verification_evidence_mismatch");
  }
  const base = {
    version: 1 as const,
    tenantId,
    repositoryId: required("execution_repository_id", input.snapshot.repositoryId),
    snapshotSha256,
    exactCommit,
    targetPaths: Object.freeze(targetPaths),
    ownersByPath: Object.freeze(ownersByPath),
    ciRun: ciRun ? Object.freeze({ ...ciRun, exactCommit: exactObjectId("execution_ci_exact_commit", ciRun.exactCommit), observedAt: new Date(ciRun.observedAt).toISOString(), verificationCommands: Object.freeze([...ciRun.verificationCommands].sort()) }) : null,
    discoveredVerificationCommands: Object.freeze(input.discovery.verificationCommands.map((command) => command.command).sort()),
    executable: reasons.size === 0,
    reasons: Object.freeze([...reasons].sort()),
    evaluatedAt,
  };
  return Object.freeze({ ...base, evidenceSha256: sha256(JSON.stringify(canonicalize(base))) });
}
