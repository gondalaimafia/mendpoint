import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_CONTROL_IDS,
  COMPLIANCE_CONTROL_CATALOG,
  COMPLIANCE_PROGRAM_SCHEMA_VERSION,
  assertComplianceEvidenceBundle,
  evaluateComplianceProgram,
  validateComplianceEvidenceBundle,
  type ComplianceEvidenceBundle,
} from "./compliance-program.js";

const REVISION = "a".repeat(40);
const COLLECTED_AT = "2026-08-01T00:00:00.000Z";
const EVALUATED_AT = "2026-08-02T00:00:00.000Z";

function bundle(): ComplianceEvidenceBundle {
  return {
    schemaVersion: COMPLIANCE_PROGRAM_SCHEMA_VERSION,
    programId: "mendpoint-enterprise-controls",
    auditedRevision: REVISION,
    generatedAt: COLLECTED_AT,
    controls: COMPLIANCE_CONTROL_CATALOG.map((control) => {
      const { id } = control;
      return {
        id,
        owner: control.owner,
        objective: control.objective,
        requirements: control.requirements,
        evidence: control.requirements.map(({ source }, index) => ({
          id: `${id}-${source}-${index}`,
          source,
          locator: source === "legal_approval" ? `legal:${id}/approval`
            : source === "external_assurance" ? `external:${id}/report`
              : source === "live_control" ? `report:${id}/run`
                : `test:${id}.test.ts`,
          result: "pass" as const,
          collectedAt: COLLECTED_AT,
          ...(source === "repository_check" || source === "live_control" ? { revision: REVISION } : {}),
        })),
      };
    }),
  };
}

describe("compliance program evidence contract", () => {
  it("requires an exact, versioned mapping for every compliance control", () => {
    const valid = bundle();
    expect(validateComplianceEvidenceBundle(valid)).toEqual([]);
    expect(() => assertComplianceEvidenceBundle(valid)).not.toThrow();

    const missing = { ...valid, controls: valid.controls.slice(1) };
    expect(validateComplianceEvidenceBundle(missing)).toContainEqual(expect.objectContaining({
      code: "CONTROL_MISSING",
      subject: "policy_governance",
    }));

    const unknown = {
      ...valid,
      controls: [...valid.controls, { ...valid.controls[0], id: "certified" }],
    };
    expect(() => assertComplianceEvidenceBundle(unknown)).toThrowError(expect.objectContaining({
      name: "ComplianceEvidenceValidationError",
    }));
  });

  it("separates repository readiness from independently trusted assurance and legal approval", () => {
    const result = evaluateComplianceProgram(bundle(), {
      evaluatedAt: EVALUATED_AT,
      auditedRevision: REVISION,
    });
    expect(result).toMatchObject({
      valid: true,
      repositoryEvidenceSatisfied: true,
      externalEvidenceSatisfied: false,
      allRequiredEvidenceSatisfied: false,
      certificationStatus: "not_assessed",
      externalBlockers: [
        "access_review:live_control",
        "asset_management:live_control",
        "vulnerability_management:live_control",
        "change_evidence:live_control",
        "dpa:legal_approval",
        "subprocessors:legal_approval",
        "retention_deletion:live_control",
        "incident_response:live_control",
        "continuity:live_control",
        "penetration_test:external_assurance",
      ],
    });

    const trusted = evaluateComplianceProgram(bundle(), {
      evaluatedAt: EVALUATED_AT,
      auditedRevision: REVISION,
      trustedExternalEvidenceIds: [
        "access_review-live_control-0",
        "asset_management-live_control-0",
        "vulnerability_management-live_control-1",
        "change_evidence-live_control-1",
        "dpa-legal_approval-0",
        "subprocessors-legal_approval-0",
        "retention_deletion-live_control-0",
        "incident_response-live_control-1",
        "continuity-live_control-1",
        "penetration_test-external_assurance-0",
      ],
    });
    expect(trusted).toMatchObject({
      valid: true,
      repositoryEvidenceSatisfied: true,
      externalEvidenceSatisfied: true,
      allRequiredEvidenceSatisfied: true,
      certificationStatus: "not_assessed",
      externalBlockers: [],
    });
  });

  it("fails closed for stale, failing, future, expired, or wrong revision evidence", () => {
    for (const mutation of [
      { result: "fail" as const },
      { collectedAt: "2026-01-01T00:00:00.000Z" },
      { collectedAt: "2026-08-03T00:00:00.000Z" },
      { expiresAt: EVALUATED_AT },
      { revision: "b".repeat(40) },
    ]) {
      const input = bundle();
      const policy = input.controls[0];
      const mutated = {
        ...input,
        controls: [{ ...policy, evidence: [{ ...policy.evidence[0], ...mutation }] }, ...input.controls.slice(1)],
      } as ComplianceEvidenceBundle;
      const result = evaluateComplianceProgram(mutated, {
        evaluatedAt: EVALUATED_AT,
        auditedRevision: REVISION,
      });
      expect(result.repositoryEvidenceSatisfied).toBe(false);
      expect(result.allRequiredEvidenceSatisfied).toBe(false);
      expect(result.controls[0]).toMatchObject({
        id: "policy_governance",
        complete: false,
        missingSources: ["repository_check"],
      });
    }
  });

  it("invalidates the entire assessment for malformed or mismatched evidence contracts", () => {
    const input = bundle();
    const invalid = {
      ...input,
      controls: input.controls.map((control, index) => index === 0
        ? {
            ...control,
            evidence: [{ ...control.evidence[0], locator: "https://unbounded.example/evidence" }],
          }
        : control),
    };
    expect(evaluateComplianceProgram(invalid as ComplianceEvidenceBundle, {
      evaluatedAt: EVALUATED_AT,
      auditedRevision: REVISION,
    })).toMatchObject({
      valid: false,
      repositoryEvidenceSatisfied: false,
      externalEvidenceSatisfied: false,
      allRequiredEvidenceSatisfied: false,
      externalBlockers: ["invalid compliance evidence bundle"],
    });

    expect(evaluateComplianceProgram(input, {
      evaluatedAt: EVALUATED_AT,
      auditedRevision: "b".repeat(40),
    })).toMatchObject({ valid: false, allRequiredEvidenceSatisfied: false });
  });

  it("rejects duplicate evidence, undeclared sources, and repository evidence without a revision", () => {
    const input = bundle();
    const first = input.controls[0];
    const second = input.controls[1];
    const malformed = {
      ...input,
      controls: [
        {
          ...first,
          evidence: [{ ...first.evidence[0], revision: undefined }],
        },
        {
          ...second,
          evidence: [{ ...second.evidence[0], id: first.evidence[0].id, source: "external_assurance" }],
        },
        ...input.controls.slice(2),
      ],
    };
    const issues = validateComplianceEvidenceBundle(malformed);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_REVISION" }),
      expect.objectContaining({ code: "EVIDENCE_DUPLICATE" }),
      expect.objectContaining({ code: "EVIDENCE_UNMAPPED" }),
    ]));
  });
});
