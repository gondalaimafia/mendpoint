import { createHash } from "node:crypto";

export const TRANSFORMER_WORKSPACE_AUTHORITY_PATH = ".mendpoint/workspace-authority.json";
export const TRANSFORMER_WORKSPACE_AUTHORITY_SCHEMA = "mendpoint.workspace-authority.v1";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MANIFEST_NAMES = new Set(["package.json", "pyproject.toml", "go.mod"]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && value.length <= 1_000 &&
    !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
    !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function workspacePath(value: unknown): value is string {
  return value === "" || safePath(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort(compareCodeUnits)) ===
    JSON.stringify([...expected].sort(compareCodeUnits));
}

function canonicalManifestText(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
}

export type TransformerWorkspaceAuthorityMember = Readonly<{
  repositoryId: string;
  revision: string;
  workspacePath: string;
  manifestPath: string;
  manifestContentDigest: string;
}>;

export type TransformerWorkspaceAuthority = Readonly<{
  schemaVersion: typeof TRANSFORMER_WORKSPACE_AUTHORITY_SCHEMA;
  tenantId: string;
  authorityId: string;
  contentDigest: string;
  members: readonly TransformerWorkspaceAuthorityMember[];
}>;

export type TransformerSnapshotWorkspaceIdentity = Readonly<{
  valid: boolean;
  reason: string | null;
  manifestPaths: readonly string[];
  manifestDirectory: string | null;
  workspacePath: string | null;
  workspaceAuthority: TransformerWorkspaceAuthority | null;
  workspaceIdentityDigest: string;
}>;

function parseAuthority(
  text: string,
  input: Readonly<{
    tenantId: string;
    repositoryId: string;
    revision: string;
    manifestPath: string;
    manifestContentDigest: string;
  }>,
): TransformerWorkspaceAuthority | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!exactKeys(record, ["schemaVersion", "tenantId", "authorityId", "members"]) ||
      record.schemaVersion !== TRANSFORMER_WORKSPACE_AUTHORITY_SCHEMA ||
      record.tenantId !== input.tenantId || typeof record.authorityId !== "string" ||
      !AUTHORITY_ID.test(record.authorityId) || !Array.isArray(record.members) ||
      record.members.length < 2 || record.members.length > 1_000) return null;
  const members: TransformerWorkspaceAuthorityMember[] = [];
  const repositoryIds = new Set<string>();
  const workspacePaths = new Set<string>();
  for (const value of record.members) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const member = value as Record<string, unknown>;
    if (!exactKeys(member, [
      "repositoryId", "revision", "workspacePath", "manifestPath", "manifestContentDigest",
    ]) || typeof member.repositoryId !== "string" || !member.repositoryId ||
        typeof member.revision !== "string" || !REVISION.test(member.revision) ||
        !workspacePath(member.workspacePath) || !safePath(member.manifestPath) ||
        !MANIFEST_NAMES.has(member.manifestPath.split("/").at(-1) ?? "") ||
        typeof member.manifestContentDigest !== "string" || !DIGEST.test(member.manifestContentDigest) ||
        repositoryIds.has(member.repositoryId) || workspacePaths.has(member.workspacePath)) return null;
    repositoryIds.add(member.repositoryId);
    workspacePaths.add(member.workspacePath);
    members.push(Object.freeze({
      repositoryId: member.repositoryId,
      revision: member.revision,
      workspacePath: member.workspacePath,
      manifestPath: member.manifestPath,
      manifestContentDigest: member.manifestContentDigest,
    }));
  }
  members.sort((left, right) => compareCodeUnits(left.repositoryId, right.repositoryId));
  const current = members.find((member) => member.repositoryId === input.repositoryId);
  if (!current || current.revision !== input.revision || current.manifestPath !== input.manifestPath ||
    current.manifestContentDigest !== input.manifestContentDigest) return null;
  const body = Object.freeze({
    schemaVersion: TRANSFORMER_WORKSPACE_AUTHORITY_SCHEMA,
    tenantId: input.tenantId,
    authorityId: record.authorityId,
    members: Object.freeze(members),
  });
  return Object.freeze({ ...body, contentDigest: sha256(canonical(body)) });
}

export function deriveTransformerSnapshotWorkspaceIdentity(input: Readonly<{
  tenantId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  files: Readonly<Record<string, string>>;
}>): TransformerSnapshotWorkspaceIdentity {
  const manifestPaths = Object.keys(input.files)
    .filter((path) => safePath(path) && MANIFEST_NAMES.has(path.split("/").at(-1) ?? ""))
    .sort(compareCodeUnits);
  const manifestDirectory = manifestPaths.length === 1
    ? manifestPaths[0]!.split("/").slice(0, -1).join("/")
    : null;
  const authorityText = input.files[TRANSFORMER_WORKSPACE_AUTHORITY_PATH];
  const authority = authorityText === undefined || manifestDirectory === null
    ? null
    : parseAuthority(authorityText, {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      revision: input.revision,
      manifestPath: manifestPaths[0]!,
      manifestContentDigest: sha256(canonicalManifestText(input.files[manifestPaths[0]!]!)),
    });
  const valid = authorityText === undefined || authority !== null;
  const logicalWorkspacePath = authority?.members.find((member) =>
    member.repositoryId === input.repositoryId)?.workspacePath ?? null;
  const workspaceIdentityDigest = sha256(canonical({
    snapshotId: input.snapshotId,
    snapshotDigest: input.snapshotDigest,
    manifestPaths,
    manifestDirectory,
    workspacePath: logicalWorkspacePath,
    workspaceAuthorityId: authority?.authorityId ?? null,
    workspaceAuthorityDigest: authority?.contentDigest ?? null,
  }));
  return Object.freeze({
    valid,
    reason: valid ? null : "workspace_authority_invalid",
    manifestPaths: Object.freeze(manifestPaths),
    manifestDirectory,
    workspacePath: logicalWorkspacePath,
    workspaceAuthority: authority,
    workspaceIdentityDigest,
  });
}
