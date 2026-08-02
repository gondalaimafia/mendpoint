export const COMPLIANCE_PROGRAM_SCHEMA_VERSION = "2026-08-02.v1" as const;

export const COMPLIANCE_CONTROL_IDS = [
  "policy_governance",
  "access_review",
  "asset_management",
  "vulnerability_management",
  "sbom",
  "change_evidence",
  "privacy",
  "dpa",
  "subprocessors",
  "retention_deletion",
  "incident_response",
  "continuity",
  "penetration_test",
  "control_mapping",
] as const;

export type ComplianceControlId = (typeof COMPLIANCE_CONTROL_IDS)[number];
export type ComplianceEvidenceSource =
  | "repository_check"
  | "live_control"
  | "external_assurance"
  | "legal_approval";

export type ComplianceEvidenceRequirement = Readonly<{
  source: ComplianceEvidenceSource;
  maxAgeDays: number;
}>;

export type ComplianceControlDefinition = Readonly<{
  id: ComplianceControlId;
  owner: string;
  objective: string;
  requirements: readonly ComplianceEvidenceRequirement[];
}>;

export const COMPLIANCE_CONTROL_CATALOG: readonly ComplianceControlDefinition[] = Object.freeze([
  { id: "policy_governance", owner: "security-platform", objective: "Maintain approved and reviewable security and privacy policies.", requirements: [{ source: "repository_check", maxAgeDays: 90 }] },
  { id: "access_review", owner: "security-platform", objective: "Review privileged access and record attributable removal decisions.", requirements: [{ source: "live_control", maxAgeDays: 90 }] },
  { id: "asset_management", owner: "security-platform", objective: "Inventory production services, data stores, integrations, and owners.", requirements: [{ source: "live_control", maxAgeDays: 30 }] },
  { id: "vulnerability_management", owner: "security-platform", objective: "Detect, triage, remediate, and retain evidence for vulnerabilities.", requirements: [{ source: "repository_check", maxAgeDays: 30 }, { source: "live_control", maxAgeDays: 30 }] },
  { id: "sbom", owner: "security-platform", objective: "Produce a revision-bound software bill of materials.", requirements: [{ source: "repository_check", maxAgeDays: 30 }] },
  { id: "change_evidence", owner: "security-platform", objective: "Retain attributable review and release evidence for production changes.", requirements: [{ source: "repository_check", maxAgeDays: 30 }, { source: "live_control", maxAgeDays: 30 }] },
  { id: "privacy", owner: "security-platform", objective: "Document processing purpose, data boundaries, and privacy request handling.", requirements: [{ source: "repository_check", maxAgeDays: 90 }] },
  { id: "dpa", owner: "legal", objective: "Retain approval evidence for the applicable data processing agreement.", requirements: [{ source: "legal_approval", maxAgeDays: 366 }] },
  { id: "subprocessors", owner: "legal", objective: "Maintain an approved and current subprocessor record.", requirements: [{ source: "legal_approval", maxAgeDays: 90 }] },
  { id: "retention_deletion", owner: "security-platform", objective: "Exercise retention and deletion controls against scoped data.", requirements: [{ source: "live_control", maxAgeDays: 90 }] },
  { id: "incident_response", owner: "security-platform", objective: "Maintain and exercise an attributable incident response process.", requirements: [{ source: "repository_check", maxAgeDays: 90 }, { source: "live_control", maxAgeDays: 180 }] },
  { id: "continuity", owner: "security-platform", objective: "Maintain and exercise recovery and continuity procedures.", requirements: [{ source: "repository_check", maxAgeDays: 90 }, { source: "live_control", maxAgeDays: 180 }] },
  { id: "penetration_test", owner: "security-platform", objective: "Track independent penetration test scope, findings, and remediation evidence.", requirements: [{ source: "external_assurance", maxAgeDays: 366 }] },
  { id: "control_mapping", owner: "security-platform", objective: "Map every in-scope control to current, attributable evidence.", requirements: [{ source: "repository_check", maxAgeDays: 90 }] },
]);

export type ComplianceEvidence = Readonly<{
  id: string;
  source: ComplianceEvidenceSource;
  locator: string;
  result: "pass" | "fail" | "not_run";
  collectedAt: string;
  expiresAt?: string;
  revision?: string;
}>;

export type ComplianceControlMapping = Readonly<{
  id: ComplianceControlId;
  owner: string;
  objective: string;
  requirements: readonly ComplianceEvidenceRequirement[];
  evidence: readonly ComplianceEvidence[];
}>;

export type ComplianceEvidenceBundle = Readonly<{
  schemaVersion: typeof COMPLIANCE_PROGRAM_SCHEMA_VERSION;
  programId: string;
  auditedRevision: string;
  generatedAt: string;
  controls: readonly ComplianceControlMapping[];
}>;

export type ComplianceEvidenceContext = Readonly<{
  evaluatedAt: string;
  auditedRevision: string;
  trustedExternalEvidenceIds?: readonly string[];
}>;

export type ComplianceEvidenceIssue = Readonly<{
  code: string;
  subject: string;
  message: string;
}>;

export type ComplianceControlAssessment = Readonly<{
  id: ComplianceControlId;
  repositoryReady: boolean;
  complete: boolean;
  missingSources: readonly ComplianceEvidenceSource[];
  failedEvidenceIds: readonly string[];
}>;

export type ComplianceProgramAssessment = Readonly<{
  valid: boolean;
  repositoryEvidenceSatisfied: boolean;
  externalEvidenceSatisfied: boolean;
  allRequiredEvidenceSatisfied: boolean;
  certificationStatus: "not_assessed";
  issues: readonly ComplianceEvidenceIssue[];
  controls: readonly ComplianceControlAssessment[];
  externalBlockers: readonly string[];
}>;

export class ComplianceEvidenceValidationError extends Error {
  constructor(readonly issues: readonly ComplianceEvidenceIssue[]) {
    super(`Compliance evidence bundle is invalid: ${issues.map((item) => item.message).join("; ")}`);
    this.name = "ComplianceEvidenceValidationError";
  }
}

const CONTROL_IDS = new Set<string>(COMPLIANCE_CONTROL_IDS);
const SOURCES = new Set<ComplianceEvidenceSource>([
  "repository_check",
  "live_control",
  "external_assurance",
  "legal_approval",
]);
const SHA = /^[0-9a-f]{40}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCATOR = /^(code|document|external|legal|report|test|workflow):\S+$/;
const TRUSTED_SOURCES = new Set<ComplianceEvidenceSource>([
  "live_control",
  "external_assurance",
  "legal_approval",
]);
const CONTROL_CATALOG = new Map(COMPLIANCE_CONTROL_CATALOG.map((control) => [control.id, control]));
const LOCATOR_SCHEMES: Readonly<Record<ComplianceEvidenceSource, ReadonlySet<string>>> = {
  repository_check: new Set(["code", "document", "test", "workflow"]),
  live_control: new Set(["report"]),
  external_assurance: new Set(["external", "report"]),
  legal_approval: new Set(["legal"]),
};

function issue(code: string, subject: string, message: string): ComplianceEvidenceIssue {
  return { code, subject, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function pathFor(controlId: string, suffix: string): string {
  return `controls.${controlId}.${suffix}`;
}

export function validateComplianceEvidenceBundle(input: unknown): ComplianceEvidenceIssue[] {
  const issues: ComplianceEvidenceIssue[] = [];
  if (!isRecord(input)) {
    return [issue("BUNDLE_TYPE", "bundle", "compliance evidence bundle must be an object")];
  }
  if (input.schemaVersion !== COMPLIANCE_PROGRAM_SCHEMA_VERSION) {
    issues.push(issue("SCHEMA_VERSION", "bundle", `schemaVersion must equal ${COMPLIANCE_PROGRAM_SCHEMA_VERSION}`));
  }
  if (!nonempty(input.programId)) {
    issues.push(issue("PROGRAM_ID", "bundle", "programId must be a non-empty trimmed string"));
  }
  if (typeof input.auditedRevision !== "string" || !SHA.test(input.auditedRevision)) {
    issues.push(issue("AUDITED_REVISION", "bundle", "auditedRevision must be a full lowercase Git revision"));
  }
  if (timestamp(input.generatedAt) === null) {
    issues.push(issue("GENERATED_AT", "bundle", "generatedAt must be a canonical UTC timestamp"));
  }
  if (!Array.isArray(input.controls)) {
    issues.push(issue("CONTROLS_TYPE", "bundle", "controls must be an array"));
    return issues.sort(compareIssues);
  }

  const seenControls = new Set<string>();
  const seenEvidence = new Set<string>();
  for (const rawControl of input.controls) {
    if (!isRecord(rawControl)) {
      issues.push(issue("CONTROL_TYPE", "controls", "each control mapping must be an object"));
      continue;
    }
    const controlId = typeof rawControl.id === "string" ? rawControl.id : "unknown";
    if (!CONTROL_IDS.has(controlId)) {
      issues.push(issue("CONTROL_ID", controlId, `unknown compliance control: ${controlId}`));
    }
    if (seenControls.has(controlId)) {
      issues.push(issue("CONTROL_DUPLICATE", controlId, `compliance control is duplicated: ${controlId}`));
    }
    seenControls.add(controlId);
    if (!nonempty(rawControl.owner)) {
      issues.push(issue("CONTROL_OWNER", controlId, "control owner must be a non-empty trimmed string"));
    }
    if (!nonempty(rawControl.objective)) {
      issues.push(issue("CONTROL_OBJECTIVE", controlId, "control objective must be a non-empty trimmed string"));
    }

    const requirements = new Set<ComplianceEvidenceSource>();
    const requirementMaxAges = new Map<ComplianceEvidenceSource, unknown>();
    if (!Array.isArray(rawControl.requirements) || rawControl.requirements.length === 0) {
      issues.push(issue("REQUIREMENTS_REQUIRED", controlId, "control must declare at least one evidence requirement"));
    } else {
      for (const rawRequirement of rawControl.requirements) {
        if (!isRecord(rawRequirement) || !SOURCES.has(rawRequirement.source as ComplianceEvidenceSource)) {
          issues.push(issue("REQUIREMENT_SOURCE", controlId, "evidence requirement source is invalid"));
          continue;
        }
        const source = rawRequirement.source as ComplianceEvidenceSource;
        if (requirements.has(source)) {
          issues.push(issue("REQUIREMENT_DUPLICATE", pathFor(controlId, source), `evidence requirement is duplicated: ${source}`));
        }
        requirements.add(source);
        requirementMaxAges.set(source, rawRequirement.maxAgeDays);
        if (!Number.isSafeInteger(rawRequirement.maxAgeDays) || Number(rawRequirement.maxAgeDays) < 1 || Number(rawRequirement.maxAgeDays) > 366) {
          issues.push(issue("REQUIREMENT_MAX_AGE", pathFor(controlId, source), "maxAgeDays must be an integer from 1 to 366"));
        }
      }
    }
    const catalog = CONTROL_CATALOG.get(controlId as ComplianceControlId);
    if (catalog) {
      if (rawControl.owner !== catalog.owner) {
        issues.push(issue("CONTROL_OWNER_POLICY", controlId, `control owner must equal ${catalog.owner}`));
      }
      if (rawControl.objective !== catalog.objective) {
        issues.push(issue("CONTROL_OBJECTIVE_POLICY", controlId, "control objective must equal the versioned catalog objective"));
      }
      const expected = new Map(catalog.requirements.map((requirement) => [requirement.source, requirement.maxAgeDays]));
      for (const [source, maxAgeDays] of expected) {
        if (!requirements.has(source)) {
          issues.push(issue("REQUIREMENT_MISSING", pathFor(controlId, source), `control requires ${source} evidence`));
        } else {
          if (requirementMaxAges.get(source) !== maxAgeDays) {
            issues.push(issue("REQUIREMENT_POLICY", pathFor(controlId, source), `maxAgeDays must equal the catalog policy of ${maxAgeDays}`));
          }
        }
      }
      for (const source of requirements) {
        if (!expected.has(source)) {
          issues.push(issue("REQUIREMENT_UNEXPECTED", pathFor(controlId, source), `control does not accept ${source} as proof`));
        }
      }
    }

    if (!Array.isArray(rawControl.evidence)) {
      issues.push(issue("EVIDENCE_TYPE", controlId, "control evidence must be an array"));
      continue;
    }
    for (const rawEvidence of rawControl.evidence) {
      if (!isRecord(rawEvidence)) {
        issues.push(issue("EVIDENCE_RECORD", controlId, "each evidence item must be an object"));
        continue;
      }
      const evidenceId = typeof rawEvidence.id === "string" ? rawEvidence.id : "unknown";
      if (!nonempty(rawEvidence.id)) {
        issues.push(issue("EVIDENCE_ID", controlId, "evidence id must be a non-empty trimmed string"));
      } else if (seenEvidence.has(evidenceId)) {
        issues.push(issue("EVIDENCE_DUPLICATE", evidenceId, `evidence id is duplicated: ${evidenceId}`));
      }
      seenEvidence.add(evidenceId);
      if (!SOURCES.has(rawEvidence.source as ComplianceEvidenceSource)) {
        issues.push(issue("EVIDENCE_SOURCE", evidenceId, "evidence source is invalid"));
      } else if (!requirements.has(rawEvidence.source as ComplianceEvidenceSource)) {
        issues.push(issue("EVIDENCE_UNMAPPED", evidenceId, "evidence source is not required by its control"));
      }
      if (typeof rawEvidence.locator !== "string" || !LOCATOR.test(rawEvidence.locator)) {
        issues.push(issue("EVIDENCE_LOCATOR", evidenceId, "evidence locator must use an approved non-empty scheme"));
      } else if (SOURCES.has(rawEvidence.source as ComplianceEvidenceSource)) {
        const scheme = rawEvidence.locator.slice(0, rawEvidence.locator.indexOf(":"));
        if (!LOCATOR_SCHEMES[rawEvidence.source as ComplianceEvidenceSource].has(scheme)) {
          issues.push(issue("EVIDENCE_LOCATOR_SOURCE", evidenceId, `locator scheme ${scheme} is not valid for ${String(rawEvidence.source)}`));
        }
      }
      if (rawEvidence.result !== "pass" && rawEvidence.result !== "fail" && rawEvidence.result !== "not_run") {
        issues.push(issue("EVIDENCE_RESULT", evidenceId, "evidence result must be pass, fail, or not_run"));
      }
      const collectedAt = timestamp(rawEvidence.collectedAt);
      const expiresAt = rawEvidence.expiresAt === undefined ? undefined : timestamp(rawEvidence.expiresAt);
      if (collectedAt === null) {
        issues.push(issue("EVIDENCE_COLLECTED_AT", evidenceId, "collectedAt must be a canonical UTC timestamp"));
      }
      if (expiresAt === null) {
        issues.push(issue("EVIDENCE_EXPIRES_AT", evidenceId, "expiresAt must be a canonical UTC timestamp"));
      } else if (expiresAt !== undefined && collectedAt !== null && expiresAt <= collectedAt) {
        issues.push(issue("EVIDENCE_EXPIRY_ORDER", evidenceId, "expiresAt must be after collectedAt"));
      }
      if (rawEvidence.source === "repository_check" || rawEvidence.source === "live_control") {
        if (typeof rawEvidence.revision !== "string" || !SHA.test(rawEvidence.revision)) {
          issues.push(issue("EVIDENCE_REVISION", evidenceId, "repository and live evidence require a full lowercase Git revision"));
        }
      } else if (rawEvidence.revision !== undefined) {
        issues.push(issue("EXTERNAL_REVISION", evidenceId, "external and legal evidence must not be represented as repository revision proof"));
      }
    }
  }

  for (const controlId of COMPLIANCE_CONTROL_IDS) {
    if (!seenControls.has(controlId)) {
      issues.push(issue("CONTROL_MISSING", controlId, `required compliance control is missing: ${controlId}`));
    }
  }
  return issues.sort(compareIssues);
}

export function assertComplianceEvidenceBundle(input: unknown): asserts input is ComplianceEvidenceBundle {
  const issues = validateComplianceEvidenceBundle(input);
  if (issues.length > 0) throw new ComplianceEvidenceValidationError(issues);
}

export function evaluateComplianceProgram(
  input: ComplianceEvidenceBundle,
  context: ComplianceEvidenceContext,
): ComplianceProgramAssessment {
  const issues = validateComplianceEvidenceBundle(input);
  const evaluatedAt = timestamp(context.evaluatedAt);
  if (evaluatedAt === null) {
    issues.push(issue("EVALUATED_AT", "context", "evaluatedAt must be a canonical UTC timestamp"));
  }
  if (!SHA.test(context.auditedRevision)) {
    issues.push(issue("CONTEXT_REVISION", "context", "context auditedRevision must be a full lowercase Git revision"));
  } else if (context.auditedRevision !== input.auditedRevision) {
    issues.push(issue("REVISION_MISMATCH", "context", "context auditedRevision must equal the evidence bundle revision"));
  }
  if (evaluatedAt !== null && timestamp(input.generatedAt) !== null && Date.parse(input.generatedAt) > evaluatedAt) {
    issues.push(issue("FUTURE_BUNDLE", "bundle", "generatedAt cannot be after evaluatedAt"));
  }

  if (issues.length > 0 || evaluatedAt === null) {
    return Object.freeze({
      valid: false,
      repositoryEvidenceSatisfied: false,
      externalEvidenceSatisfied: false,
      allRequiredEvidenceSatisfied: false,
      certificationStatus: "not_assessed" as const,
      issues: Object.freeze([...issues].sort(compareIssues)),
      controls: Object.freeze([]),
      externalBlockers: Object.freeze(["invalid compliance evidence bundle"]),
    });
  }

  const trusted = new Set(context.trustedExternalEvidenceIds ?? []);
  const controls = input.controls.map((control) => {
    const missingSources: ComplianceEvidenceSource[] = [];
    const failedEvidenceIds = new Set<string>();
    for (const requirement of control.requirements) {
      const candidates = control.evidence.filter((item) => item.source === requirement.source);
      const satisfies = candidates.some((item) => {
        if (item.result !== "pass") {
          failedEvidenceIds.add(item.id);
          return false;
        }
        const collectedAt = Date.parse(item.collectedAt);
        if (collectedAt > evaluatedAt || evaluatedAt - collectedAt > requirement.maxAgeDays * 86_400_000) {
          failedEvidenceIds.add(item.id);
          return false;
        }
        if (item.expiresAt !== undefined && Date.parse(item.expiresAt) <= evaluatedAt) {
          failedEvidenceIds.add(item.id);
          return false;
        }
        if ((item.source === "repository_check" || item.source === "live_control") && item.revision !== input.auditedRevision) {
          failedEvidenceIds.add(item.id);
          return false;
        }
        if (TRUSTED_SOURCES.has(item.source) && !trusted.has(item.id)) {
          failedEvidenceIds.add(item.id);
          return false;
        }
        return true;
      });
      if (!satisfies) missingSources.push(requirement.source);
    }
    const repositorySources = control.requirements.filter((item) => item.source === "repository_check");
    const repositoryReady = repositorySources.every((requirement) => !missingSources.includes(requirement.source));
    return Object.freeze({
      id: control.id,
      repositoryReady,
      complete: missingSources.length === 0,
      missingSources: Object.freeze(missingSources),
      failedEvidenceIds: Object.freeze([...failedEvidenceIds].sort()),
    });
  });
  const externalBlockers = controls.flatMap((control) =>
    control.missingSources
      .filter((source) => TRUSTED_SOURCES.has(source))
      .map((source) => `${control.id}:${source}`),
  );
  const repositoryReady = controls.every((control) => control.repositoryReady);
  const externallyVerified = externalBlockers.length === 0;
  return Object.freeze({
    valid: true,
    repositoryEvidenceSatisfied: repositoryReady,
    externalEvidenceSatisfied: externallyVerified,
    allRequiredEvidenceSatisfied: controls.every((control) => control.complete),
    certificationStatus: "not_assessed" as const,
    issues: Object.freeze([]),
    controls: Object.freeze(controls),
    externalBlockers: Object.freeze(externalBlockers),
  });
}

function compareIssues(left: ComplianceEvidenceIssue, right: ComplianceEvidenceIssue): number {
  return left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject) || left.message.localeCompare(right.message);
}
