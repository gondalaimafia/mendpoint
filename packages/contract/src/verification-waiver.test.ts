import { describe, expect, it } from "vitest";
import {
  canonicalVerificationWaiverDigest,
  evaluateVerificationWaiver,
  issueVerificationWaiver,
  validateVerificationWaiver,
  type VerificationWaiver,
  type VerificationWaiverInput,
} from "./verification-waiver.js";

const SIGNING_KEY = "test-only-signing-key-with-enough-entropy";
const SCOPE = { tenantId: "tenant-1", runId: "run-1", checkId: "contract-tests" };

function validInput(): VerificationWaiverInput {
  return {
    waiverId: "waiver-1",
    scope: { ...SCOPE },
    issuedBy: { kind: "human", id: "user-123" },
    reason: "Provider sandbox is unavailable during the scheduled verification window.",
    issuedAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-08-01T11:00:00.000Z",
  };
}

function activeWaiver(): VerificationWaiver {
  return issueVerificationWaiver(validInput(), SIGNING_KEY);
}

describe("verification waiver contract", () => {
  it("accepts only an attributable signed waiver in its exact scope and validity window", () => {
    const waiver = activeWaiver();
    expect(validateVerificationWaiver(waiver)).toEqual([]);
    expect(
      evaluateVerificationWaiver({
        waiver,
        context: SCOPE,
        now: "2026-08-01T10:30:00.000Z",
        signingKey: SIGNING_KEY,
      }),
    ).toMatchObject({ status: "active", accepted: true, mismatchedScope: [] });
  });

  it("expires at the exact supplied expiry time", () => {
    expect(
      evaluateVerificationWaiver({
        waiver: activeWaiver(),
        context: SCOPE,
        now: "2026-08-01T11:00:00.000Z",
        signingKey: SIGNING_KEY,
      }),
    ).toMatchObject({ status: "expired", accepted: false });
  });

  it.each([
    ["tenantId", { ...SCOPE, tenantId: "tenant-2" }],
    ["runId", { ...SCOPE, runId: "run-2" }],
    ["checkId", { ...SCOPE, checkId: "security-scan" }],
  ] as const)("rejects a waiver used for the wrong %s", (dimension, context) => {
    expect(
      evaluateVerificationWaiver({
        waiver: activeWaiver(),
        context,
        now: "2026-08-01T10:30:00.000Z",
        signingKey: SIGNING_KEY,
      }),
    ).toMatchObject({
      status: "scope_mismatch",
      accepted: false,
      mismatchedScope: [dimension],
    });
  });

  it("rejects a missing waiver reason", () => {
    const input = { ...validInput(), reason: "" };
    expect(validateVerificationWaiver(input)).toContainEqual(
      expect.objectContaining({ code: "FIELD_REQUIRED", path: "reason" }),
    );
    expect(() => issueVerificationWaiver(input, SIGNING_KEY)).toThrowError(
      expect.objectContaining({ name: "VerificationWaiverValidationError" }),
    );
  });

  it("rejects a service actor when policy requires a human", () => {
    const input: VerificationWaiverInput = {
      ...validInput(),
      issuedBy: { kind: "service", id: "worker-1" },
    };
    expect(validateVerificationWaiver(input, { requireHumanActor: true })).toContainEqual(
      expect.objectContaining({ code: "ACTOR_POLICY", path: "issuedBy.kind" }),
    );
    expect(() =>
      issueVerificationWaiver(input, SIGNING_KEY, { requireHumanActor: true }),
    ).toThrowError(expect.objectContaining({ name: "VerificationWaiverValidationError" }));
  });

  it("rejects scope dimensions outside the allowed tenant, run, and check dimensions", () => {
    const input = validInput() as VerificationWaiverInput & {
      scope: VerificationWaiverInput["scope"] & { repositoryId: string };
    };
    input.scope = { ...input.scope, repositoryId: "repo-1" };
    expect(validateVerificationWaiver(input)).toContainEqual(
      expect.objectContaining({ code: "SCOPE_DIMENSION", path: "scope.repositoryId" }),
    );
  });

  it("uses a canonical keyed digest and detects payload or key tampering", () => {
    const input = validInput();
    const reordered: VerificationWaiverInput = {
      expiresAt: input.expiresAt,
      issuedAt: input.issuedAt,
      reason: input.reason,
      issuedBy: { id: input.issuedBy.id, kind: input.issuedBy.kind },
      scope: {
        checkId: input.scope.checkId,
        runId: input.scope.runId,
        tenantId: input.scope.tenantId,
      },
      waiverId: input.waiverId,
    };
    expect(canonicalVerificationWaiverDigest(input, SIGNING_KEY)).toBe(
      canonicalVerificationWaiverDigest(reordered, SIGNING_KEY),
    );

    const waiver = activeWaiver();
    const tampered = { ...waiver, reason: "Skip all checks." };
    expect(
      evaluateVerificationWaiver({
        waiver: tampered,
        context: SCOPE,
        now: "2026-08-01T10:30:00.000Z",
        signingKey: SIGNING_KEY,
      }),
    ).toMatchObject({ status: "tampered", accepted: false });
    expect(
      evaluateVerificationWaiver({
        waiver,
        context: SCOPE,
        now: "2026-08-01T10:30:00.000Z",
        signingKey: "wrong-signing-key",
      }),
    ).toMatchObject({ status: "tampered", accepted: false });
  });
});
