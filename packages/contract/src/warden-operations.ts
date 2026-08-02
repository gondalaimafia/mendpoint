import { createHash, timingSafeEqual } from "node:crypto";

export type StructuredPrScopedRef = Readonly<{
  tenantId: string;
  id: string;
}>;

export type StructuredPrFindingLink = Readonly<{
  tenantId: string;
  findingId: string;
  evidenceArtifactIds: readonly string[];
}>;

export type StructuredPrCandidateEditLink = Readonly<{
  editId: string;
  path: string;
  findingIds: readonly string[];
}>;

export type StructuredPrPackageV1Input = Readonly<{
  packageId: string;
  tenantId: string;
  pullRequestId: string;
  createdAt: string;
  summary: string;
  rationale: string;
  risks: readonly string[];
  source: Readonly<{
    artifacts: readonly StructuredPrScopedRef[];
  }>;
  snapshot: Readonly<{
    tenantId: string;
    snapshotId: string;
    repositoryId: string;
    revisionKind: "git_commit" | "content_manifest";
    resolvedSha: string;
    manifestSha256: string;
  }>;
  findings: readonly StructuredPrFindingLink[];
  candidate: Readonly<{
    tenantId: string;
    artifactId: string;
    sha256: string;
    predecessorArtifactId: string | null;
    edits: readonly StructuredPrCandidateEditLink[];
  }>;
  verification: Readonly<{
    tenantId: string;
    artifactIds: readonly string[];
    evidenceRecordIds: readonly string[];
    verdict: "passed" | "waived";
    waiverArtifactId: string | null;
    results: readonly Readonly<{
      checkId: string;
      status: "passed" | "waived";
      evidenceRecordIds: readonly string[];
    }>[];
  }>;
  generation: Readonly<{
    kind: "recipe" | "model";
    executorId: string;
    version: string;
  }>;
  policy: Readonly<{
    tenantId: string;
    artifactId: string;
    policyId: string;
    version: string;
    decision: "allow";
  }>;
  ownership: Readonly<{
    tenantId: string;
    codeownersArtifactId: string;
    ownerPrincipalIds: readonly string[];
  }>;
  review: Readonly<{
    tenantId: string;
    requirementsArtifactId: string;
    requiredReviewerCount: number;
    reviewerPrincipalIds: readonly string[];
  }>;
  rollback: Readonly<{
    tenantId: string;
    artifactId: string;
    strategy: "revert_commit" | "restore_snapshot" | "close_draft";
    verificationEvidenceRecordIds: readonly string[];
    instructions: string;
  }>;
  delivery: Readonly<{
    mode: "draft";
    autoMerge: false;
    autoDeploy: false;
  }>;
}>;

export type StructuredPrPackageV1 = StructuredPrPackageV1Input &
  Readonly<{
    schemaVersion: 1;
    integrity: Readonly<{
      algorithm: "sha256";
      digest: string;
    }>;
  }>;

export type StructuredPrPackageIssueCode =
  | "OBJECT_REQUIRED"
  | "FIELD_REQUIRED"
  | "UNKNOWN_FIELD"
  | "INVALID_VALUE"
  | "LINK_REQUIRED"
  | "DUPLICATE_LINK"
  | "TENANT_MISMATCH"
  | "CROSS_LINK_MISSING"
  | "INTEGRITY_INVALID";

export type StructuredPrPackageIssue = Readonly<{
  code: StructuredPrPackageIssueCode;
  path: string;
  message: string;
}>;

export class StructuredPrPackageValidationError extends Error {
  constructor(readonly issues: readonly StructuredPrPackageIssue[]) {
    super(`Structured PR package is invalid: ${issues.map((item) => item.message).join("; ")}`);
    this.name = "StructuredPrPackageValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const PAYLOAD_FIELDS = [
  "packageId",
  "tenantId",
  "pullRequestId",
  "createdAt",
  "summary",
  "rationale",
  "risks",
  "source",
  "snapshot",
  "findings",
  "candidate",
  "verification",
  "generation",
  "policy",
  "ownership",
  "review",
  "rollback",
  "delivery",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function issue(
  code: StructuredPrPackageIssueCode,
  path: string,
  message: string,
): StructuredPrPackageIssue {
  return { code, path, message };
}

function asObject(
  value: unknown,
  path: string,
  issues: StructuredPrPackageIssue[],
): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("OBJECT_REQUIRED", path, `${path} must be an object`));
    return null;
  }
  return value as UnknownRecord;
}

function rejectUnknown(
  value: UnknownRecord,
  allowedFields: readonly string[],
  path: string,
  issues: StructuredPrPackageIssue[],
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      const fieldPath = path ? `${path}.${field}` : field;
      issues.push(issue("UNKNOWN_FIELD", fieldPath, `${fieldPath} is not allowed`));
    }
  }
}

function requiredText(
  value: unknown,
  path: string,
  issues: StructuredPrPackageIssue[],
): value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    issues.push(issue("FIELD_REQUIRED", path, `${path} must be a nonempty trimmed string`));
    return false;
  }
  return true;
}

function exactTenant(
  value: unknown,
  tenantId: string | null,
  path: string,
  issues: StructuredPrPackageIssue[],
): void {
  if (!requiredText(value, path, issues)) return;
  if (tenantId !== null && value !== tenantId) {
    issues.push(issue("TENANT_MISMATCH", path, `${path} does not match package tenant`));
  }
}

function stringList(
  value: unknown,
  path: string,
  issues: StructuredPrPackageIssue[],
  options: { nonempty: boolean } = { nonempty: true },
): string[] {
  if (!Array.isArray(value)) {
    issues.push(issue("LINK_REQUIRED", path, `${path} must be an array`));
    return [];
  }
  if (options.nonempty && value.length === 0) {
    issues.push(issue("LINK_REQUIRED", path, `${path} must contain at least one link`));
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (requiredText(item, `${path}[${index}]`, issues)) result.push(item);
  }
  const seen = new Set<string>();
  for (const item of result) {
    if (seen.has(item)) {
      issues.push(issue("DUPLICATE_LINK", path, `${path} contains duplicate link ${item}`));
    }
    seen.add(item);
  }
  return result;
}

function validatePayload(value: unknown): {
  issues: StructuredPrPackageIssue[];
  record: UnknownRecord | null;
} {
  const issues: StructuredPrPackageIssue[] = [];
  const record = asObject(value, "package", issues);
  if (!record) return { issues, record };
  rejectUnknown(record, PAYLOAD_FIELDS, "", issues);
  const tenantId = requiredText(record.tenantId, "tenantId", issues)
    ? record.tenantId
    : null;
  requiredText(record.packageId, "packageId", issues);
  requiredText(record.pullRequestId, "pullRequestId", issues);
  requiredText(record.summary, "summary", issues);
  requiredText(record.rationale, "rationale", issues);
  stringList(record.risks, "risks", issues);
  if (
    !requiredText(record.createdAt, "createdAt", issues) ||
    !CANONICAL_TIME.test(record.createdAt) ||
    new Date(record.createdAt).toISOString() !== record.createdAt
  ) {
    issues.push(issue("INVALID_VALUE", "createdAt", "createdAt must be canonical UTC time"));
  }

  const source = asObject(record.source, "source", issues);
  if (source) {
    rejectUnknown(source, ["artifacts"], "source", issues);
    if (!Array.isArray(source.artifacts)) {
      issues.push(issue("LINK_REQUIRED", "source.artifacts", "source artifacts are required"));
    } else {
      if (source.artifacts.length === 0) {
        issues.push(issue("LINK_REQUIRED", "source.artifacts", "source artifacts are required"));
      }
      const ids = new Set<string>();
      for (const [index, raw] of source.artifacts.entries()) {
        const link = asObject(raw, `source.artifacts[${index}]`, issues);
        if (!link) continue;
        rejectUnknown(link, ["tenantId", "id"], `source.artifacts[${index}]`, issues);
        exactTenant(link.tenantId, tenantId, `source.artifacts[${index}].tenantId`, issues);
        if (requiredText(link.id, `source.artifacts[${index}].id`, issues)) {
          if (ids.has(link.id)) {
            issues.push(
              issue("DUPLICATE_LINK", "source.artifacts", `duplicate source artifact ${link.id}`),
            );
          }
          ids.add(link.id);
        }
      }
    }
  }

  const snapshot = asObject(record.snapshot, "snapshot", issues);
  if (snapshot) {
    rejectUnknown(
      snapshot,
      ["tenantId", "snapshotId", "repositoryId", "revisionKind", "resolvedSha", "manifestSha256"],
      "snapshot",
      issues,
    );
    exactTenant(snapshot.tenantId, tenantId, "snapshot.tenantId", issues);
    requiredText(snapshot.snapshotId, "snapshot.snapshotId", issues);
    requiredText(snapshot.repositoryId, "snapshot.repositoryId", issues);
    if (snapshot.revisionKind !== "git_commit" && snapshot.revisionKind !== "content_manifest") {
      issues.push(issue("INVALID_VALUE", "snapshot.revisionKind", "snapshot revision kind is invalid"));
    }
    if (
      !requiredText(snapshot.resolvedSha, "snapshot.resolvedSha", issues) ||
      !COMMIT_SHA.test(snapshot.resolvedSha)
    ) {
      issues.push(issue("INVALID_VALUE", "snapshot.resolvedSha", "snapshot SHA is invalid"));
    }
    if (
      !requiredText(snapshot.manifestSha256, "snapshot.manifestSha256", issues) ||
      !SHA256.test(snapshot.manifestSha256)
    ) {
      issues.push(
        issue("INVALID_VALUE", "snapshot.manifestSha256", "snapshot manifest digest is invalid"),
      );
    }
  }

  const findingIds = new Set<string>();
  if (!Array.isArray(record.findings) || record.findings.length === 0) {
    issues.push(issue("LINK_REQUIRED", "findings", "at least one finding link is required"));
  } else {
    for (const [index, raw] of record.findings.entries()) {
      const finding = asObject(raw, `findings[${index}]`, issues);
      if (!finding) continue;
      rejectUnknown(
        finding,
        ["tenantId", "findingId", "evidenceArtifactIds"],
        `findings[${index}]`,
        issues,
      );
      exactTenant(finding.tenantId, tenantId, `findings[${index}].tenantId`, issues);
      if (requiredText(finding.findingId, `findings[${index}].findingId`, issues)) {
        if (findingIds.has(finding.findingId)) {
          issues.push(issue("DUPLICATE_LINK", "findings", `duplicate finding ${finding.findingId}`));
        }
        findingIds.add(finding.findingId);
      }
      stringList(finding.evidenceArtifactIds, `findings[${index}].evidenceArtifactIds`, issues);
    }
  }

  const candidate = asObject(record.candidate, "candidate", issues);
  if (candidate) {
    rejectUnknown(
      candidate,
      ["tenantId", "artifactId", "sha256", "predecessorArtifactId", "edits"],
      "candidate",
      issues,
    );
    exactTenant(candidate.tenantId, tenantId, "candidate.tenantId", issues);
    requiredText(candidate.artifactId, "candidate.artifactId", issues);
    if (!requiredText(candidate.sha256, "candidate.sha256", issues) || !SHA256.test(candidate.sha256)) {
      issues.push(issue("INVALID_VALUE", "candidate.sha256", "candidate digest is invalid"));
    }
    if (
      candidate.predecessorArtifactId !== null &&
      !requiredText(candidate.predecessorArtifactId, "candidate.predecessorArtifactId", issues)
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          "candidate.predecessorArtifactId",
          "candidate predecessor must be a link or null",
        ),
      );
    }
    if (!Array.isArray(candidate.edits) || candidate.edits.length === 0) {
      issues.push(issue("LINK_REQUIRED", "candidate.edits", "candidate edits are required"));
    } else {
      const editIds = new Set<string>();
      for (const [index, raw] of candidate.edits.entries()) {
        const edit = asObject(raw, `candidate.edits[${index}]`, issues);
        if (!edit) continue;
        rejectUnknown(edit, ["editId", "path", "findingIds"], `candidate.edits[${index}]`, issues);
        if (requiredText(edit.editId, `candidate.edits[${index}].editId`, issues)) {
          if (editIds.has(edit.editId)) {
            issues.push(issue("DUPLICATE_LINK", "candidate.edits", `duplicate edit ${edit.editId}`));
          }
          editIds.add(edit.editId);
        }
        requiredText(edit.path, `candidate.edits[${index}].path`, issues);
        const linkedFindings = stringList(
          edit.findingIds,
          `candidate.edits[${index}].findingIds`,
          issues,
        );
        for (const findingId of linkedFindings) {
          if (!findingIds.has(findingId)) {
            issues.push(
              issue(
                "CROSS_LINK_MISSING",
                `candidate.edits[${index}].findingIds`,
                `candidate edit references undeclared finding ${findingId}`,
              ),
            );
          }
        }
      }
    }
  }

  const verificationEvidenceIds = new Set<string>();
  const verification = asObject(record.verification, "verification", issues);
  if (verification) {
    rejectUnknown(
      verification,
      ["tenantId", "artifactIds", "evidenceRecordIds", "verdict", "waiverArtifactId", "results"],
      "verification",
      issues,
    );
    exactTenant(verification.tenantId, tenantId, "verification.tenantId", issues);
    stringList(verification.artifactIds, "verification.artifactIds", issues);
    for (const id of stringList(
      verification.evidenceRecordIds,
      "verification.evidenceRecordIds",
      issues,
    )) {
      verificationEvidenceIds.add(id);
    }
    if (verification.verdict !== "passed" && verification.verdict !== "waived") {
      issues.push(
        issue("INVALID_VALUE", "verification.verdict", "verification verdict must pass or waive"),
      );
    }
    if (verification.verdict === "waived") {
      requiredText(verification.waiverArtifactId, "verification.waiverArtifactId", issues);
    } else if (verification.waiverArtifactId !== null) {
      issues.push(
        issue(
          "INVALID_VALUE",
          "verification.waiverArtifactId",
          "passing verification cannot link a waiver",
        ),
      );
    }
    if (!Array.isArray(verification.results) || verification.results.length === 0) {
      issues.push(issue("LINK_REQUIRED", "verification.results", "verification results are required"));
    } else {
      const checkIds = new Set<string>();
      for (const [index, raw] of verification.results.entries()) {
        const result = asObject(raw, `verification.results[${index}]`, issues);
        if (!result) continue;
        rejectUnknown(
          result,
          ["checkId", "status", "evidenceRecordIds"],
          `verification.results[${index}]`,
          issues,
        );
        if (requiredText(result.checkId, `verification.results[${index}].checkId`, issues)) {
          if (checkIds.has(result.checkId)) {
            issues.push(issue("DUPLICATE_LINK", "verification.results", `duplicate verification check ${result.checkId}`));
          }
          checkIds.add(result.checkId);
        }
        if (result.status !== "passed" && result.status !== "waived") {
          issues.push(issue("INVALID_VALUE", `verification.results[${index}].status`, "verification result status is invalid"));
        }
        for (const evidenceId of stringList(
          result.evidenceRecordIds,
          `verification.results[${index}].evidenceRecordIds`,
          issues,
        )) {
          if (!verificationEvidenceIds.has(evidenceId)) {
            issues.push(issue(
              "CROSS_LINK_MISSING",
              `verification.results[${index}].evidenceRecordIds`,
              `verification result references undeclared evidence ${evidenceId}`,
            ));
          }
        }
      }
    }
  }

  const generation = asObject(record.generation, "generation", issues);
  if (generation) {
    rejectUnknown(generation, ["kind", "executorId", "version"], "generation", issues);
    if (generation.kind !== "recipe" && generation.kind !== "model") {
      issues.push(issue("INVALID_VALUE", "generation.kind", "generation kind is invalid"));
    }
    requiredText(generation.executorId, "generation.executorId", issues);
    requiredText(generation.version, "generation.version", issues);
  }

  const policy = asObject(record.policy, "policy", issues);
  if (policy) {
    rejectUnknown(
      policy,
      ["tenantId", "artifactId", "policyId", "version", "decision"],
      "policy",
      issues,
    );
    exactTenant(policy.tenantId, tenantId, "policy.tenantId", issues);
    requiredText(policy.artifactId, "policy.artifactId", issues);
    requiredText(policy.policyId, "policy.policyId", issues);
    requiredText(policy.version, "policy.version", issues);
    if (policy.decision !== "allow") {
      issues.push(issue("INVALID_VALUE", "policy.decision", "PR package policy must allow delivery"));
    }
  }

  const ownership = asObject(record.ownership, "ownership", issues);
  if (ownership) {
    rejectUnknown(
      ownership,
      ["tenantId", "codeownersArtifactId", "ownerPrincipalIds"],
      "ownership",
      issues,
    );
    exactTenant(ownership.tenantId, tenantId, "ownership.tenantId", issues);
    requiredText(ownership.codeownersArtifactId, "ownership.codeownersArtifactId", issues);
    stringList(ownership.ownerPrincipalIds, "ownership.ownerPrincipalIds", issues);
  }

  const review = asObject(record.review, "review", issues);
  if (review) {
    rejectUnknown(
      review,
      ["tenantId", "requirementsArtifactId", "requiredReviewerCount", "reviewerPrincipalIds"],
      "review",
      issues,
    );
    exactTenant(review.tenantId, tenantId, "review.tenantId", issues);
    requiredText(review.requirementsArtifactId, "review.requirementsArtifactId", issues);
    const reviewers = stringList(review.reviewerPrincipalIds, "review.reviewerPrincipalIds", issues);
    if (
      !Number.isSafeInteger(review.requiredReviewerCount) ||
      Number(review.requiredReviewerCount) < 1 ||
      Number(review.requiredReviewerCount) > reviewers.length
    ) {
      issues.push(
        issue(
          "INVALID_VALUE",
          "review.requiredReviewerCount",
          "required reviewer count must be covered by linked reviewers",
        ),
      );
    }
  }

  const rollback = asObject(record.rollback, "rollback", issues);
  if (rollback) {
    rejectUnknown(
      rollback,
      ["tenantId", "artifactId", "strategy", "verificationEvidenceRecordIds", "instructions"],
      "rollback",
      issues,
    );
    exactTenant(rollback.tenantId, tenantId, "rollback.tenantId", issues);
    requiredText(rollback.artifactId, "rollback.artifactId", issues);
    requiredText(rollback.instructions, "rollback.instructions", issues);
    if (!new Set(["revert_commit", "restore_snapshot", "close_draft"]).has(String(rollback.strategy))) {
      issues.push(issue("INVALID_VALUE", "rollback.strategy", "rollback strategy is invalid"));
    }
    for (const evidenceId of stringList(
      rollback.verificationEvidenceRecordIds,
      "rollback.verificationEvidenceRecordIds",
      issues,
    )) {
      if (!verificationEvidenceIds.has(evidenceId)) {
        issues.push(
          issue(
            "CROSS_LINK_MISSING",
            "rollback.verificationEvidenceRecordIds",
            `rollback references undeclared verification evidence ${evidenceId}`,
          ),
        );
      }
    }
  }

  const delivery = asObject(record.delivery, "delivery", issues);
  if (delivery) {
    rejectUnknown(delivery, ["mode", "autoMerge", "autoDeploy"], "delivery", issues);
    if (delivery.mode !== "draft") {
      issues.push(issue("INVALID_VALUE", "delivery.mode", "delivery mode must be draft"));
    }
    if (delivery.autoMerge !== false) {
      issues.push(issue("INVALID_VALUE", "delivery.autoMerge", "automatic merge is forbidden"));
    }
    if (delivery.autoDeploy !== false) {
      issues.push(issue("INVALID_VALUE", "delivery.autoDeploy", "automatic deployment is forbidden"));
    }
  }

  return { issues, record };
}

function payloadFrom(value: StructuredPrPackageV1Input | StructuredPrPackageV1): StructuredPrPackageV1Input {
  const candidate = value as StructuredPrPackageV1Input & { schemaVersion?: unknown; integrity?: unknown };
  return {
    packageId: candidate.packageId,
    tenantId: candidate.tenantId,
    pullRequestId: candidate.pullRequestId,
    createdAt: candidate.createdAt,
    summary: candidate.summary,
    rationale: candidate.rationale,
    risks: candidate.risks,
    source: candidate.source,
    snapshot: candidate.snapshot,
    findings: candidate.findings,
    candidate: candidate.candidate,
    verification: candidate.verification,
    generation: candidate.generation,
    policy: candidate.policy,
    ownership: candidate.ownership,
    review: candidate.review,
    rollback: candidate.rollback,
    delivery: candidate.delivery,
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizedPayload(input: StructuredPrPackageV1Input): unknown {
  return {
    packageId: input.packageId,
    tenantId: input.tenantId,
    pullRequestId: input.pullRequestId,
    createdAt: input.createdAt,
    summary: input.summary,
    rationale: input.rationale,
    risks: sorted(input.risks),
    source: {
      artifacts: [...input.source.artifacts]
        .map((item) => ({ tenantId: item.tenantId, id: item.id }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    snapshot: { ...input.snapshot },
    findings: [...input.findings]
      .map((item) => ({
        tenantId: item.tenantId,
        findingId: item.findingId,
        evidenceArtifactIds: sorted(item.evidenceArtifactIds),
      }))
      .sort((left, right) => left.findingId.localeCompare(right.findingId)),
    candidate: {
      tenantId: input.candidate.tenantId,
      artifactId: input.candidate.artifactId,
      sha256: input.candidate.sha256,
      predecessorArtifactId: input.candidate.predecessorArtifactId,
      edits: [...input.candidate.edits]
        .map((item) => ({ editId: item.editId, path: item.path, findingIds: sorted(item.findingIds) }))
        .sort((left, right) => left.editId.localeCompare(right.editId)),
    },
    verification: {
      tenantId: input.verification.tenantId,
      artifactIds: sorted(input.verification.artifactIds),
      evidenceRecordIds: sorted(input.verification.evidenceRecordIds),
      verdict: input.verification.verdict,
      waiverArtifactId: input.verification.waiverArtifactId,
      results: [...input.verification.results]
        .map((result) => ({
          checkId: result.checkId,
          status: result.status,
          evidenceRecordIds: sorted(result.evidenceRecordIds),
        }))
        .sort((left, right) => left.checkId.localeCompare(right.checkId)),
    },
    generation: { ...input.generation },
    policy: { ...input.policy },
    ownership: {
      tenantId: input.ownership.tenantId,
      codeownersArtifactId: input.ownership.codeownersArtifactId,
      ownerPrincipalIds: sorted(input.ownership.ownerPrincipalIds),
    },
    review: {
      tenantId: input.review.tenantId,
      requirementsArtifactId: input.review.requirementsArtifactId,
      requiredReviewerCount: input.review.requiredReviewerCount,
      reviewerPrincipalIds: sorted(input.review.reviewerPrincipalIds),
    },
    rollback: {
      tenantId: input.rollback.tenantId,
      artifactId: input.rollback.artifactId,
      strategy: input.rollback.strategy,
      verificationEvidenceRecordIds: sorted(input.rollback.verificationEvidenceRecordIds),
      instructions: input.rollback.instructions,
    },
    delivery: { ...input.delivery },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as UnknownRecord;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical_value_invalid");
}

export function canonicalStructuredPrPackageDigest(
  value: StructuredPrPackageV1Input | StructuredPrPackageV1,
): string {
  const input = payloadFrom(value);
  const validation = validatePayload(input);
  if (validation.issues.length > 0) throw new StructuredPrPackageValidationError(validation.issues);
  return createHash("sha256").update(canonicalJson(normalizedPayload(input)), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as UnknownRecord)) deepFreeze(child);
  }
  return value;
}

export function createStructuredPrPackageV1(
  input: StructuredPrPackageV1Input,
): StructuredPrPackageV1 {
  const validation = validatePayload(input);
  if (validation.issues.length > 0) throw new StructuredPrPackageValidationError(validation.issues);
  const payload = structuredClone(input);
  return deepFreeze({
    schemaVersion: 1 as const,
    ...payload,
    integrity: {
      algorithm: "sha256" as const,
      digest: canonicalStructuredPrPackageDigest(payload),
    },
  });
}

export function validateStructuredPrPackageV1(value: unknown): StructuredPrPackageIssue[] {
  const issues: StructuredPrPackageIssue[] = [];
  const record = asObject(value, "package", issues);
  if (!record) return issues;
  rejectUnknown(record, [...PAYLOAD_FIELDS, "schemaVersion", "integrity"], "", issues);
  if (record.schemaVersion !== 1) {
    issues.push(issue("INVALID_VALUE", "schemaVersion", "schemaVersion must be 1"));
  }
  const payload = payloadFrom(record as unknown as StructuredPrPackageV1);
  const payloadValidation = validatePayload(payload);
  issues.push(...payloadValidation.issues);
  const integrity = asObject(record.integrity, "integrity", issues);
  if (integrity) {
    rejectUnknown(integrity, ["algorithm", "digest"], "integrity", issues);
    if (integrity.algorithm !== "sha256" || typeof integrity.digest !== "string" || !SHA256.test(integrity.digest)) {
      issues.push(issue("INTEGRITY_INVALID", "integrity", "integrity metadata is invalid"));
    } else if (payloadValidation.issues.length === 0) {
      const expected = Buffer.from(canonicalStructuredPrPackageDigest(payload), "hex");
      const supplied = Buffer.from(integrity.digest, "hex");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        issues.push(issue("INTEGRITY_INVALID", "integrity.digest", "package digest does not match"));
      }
    }
  }
  return issues;
}

export function assertStructuredPrPackageV1(value: unknown): asserts value is StructuredPrPackageV1 {
  const issues = validateStructuredPrPackageV1(value);
  if (issues.length > 0) throw new StructuredPrPackageValidationError(issues);
}

export function verifyStructuredPrPackageV1(value: unknown): value is StructuredPrPackageV1 {
  return validateStructuredPrPackageV1(value).length === 0;
}
