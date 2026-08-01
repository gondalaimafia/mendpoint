import { createHmac, timingSafeEqual } from "node:crypto";

export const VERIFICATION_WAIVER_SCOPE_DIMENSIONS = [
  "tenantId",
  "runId",
  "checkId",
] as const;

export type VerificationWaiverScopeDimension =
  (typeof VERIFICATION_WAIVER_SCOPE_DIMENSIONS)[number];

export type VerificationWaiverScope = Readonly<
  Record<VerificationWaiverScopeDimension, string>
>;

export type VerificationWaiverActor = Readonly<{
  kind: "human" | "service";
  id: string;
}>;

export type VerificationWaiverInput = Readonly<{
  waiverId: string;
  scope: VerificationWaiverScope;
  issuedBy: VerificationWaiverActor;
  reason: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type VerificationWaiver = VerificationWaiverInput &
  Readonly<{
    schemaVersion: 1;
    integrity: Readonly<{
      algorithm: "hmac-sha256";
      digest: string;
    }>;
  }>;

export type VerificationWaiverPolicy = Readonly<{
  requireHumanActor?: boolean;
  maxTtlMs?: number;
}>;

export type VerificationWaiverIssueCode =
  | "FIELD_REQUIRED"
  | "TIMESTAMP_INVALID"
  | "EXPIRY_INVALID"
  | "TTL_EXCEEDED"
  | "SCOPE_DIMENSION"
  | "ACTOR_POLICY"
  | "INTEGRITY_INVALID";

export type VerificationWaiverIssue = Readonly<{
  code: VerificationWaiverIssueCode;
  path: string;
  message: string;
}>;

export type VerificationWaiverEvaluationContext = VerificationWaiverScope;

export type VerificationWaiverStatus =
  | "active"
  | "not_yet_active"
  | "expired"
  | "scope_mismatch"
  | "tampered"
  | "invalid";

export type VerificationWaiverEvaluation = Readonly<{
  status: VerificationWaiverStatus;
  accepted: boolean;
  issues: readonly VerificationWaiverIssue[];
  mismatchedScope: readonly VerificationWaiverScopeDimension[];
}>;

export class VerificationWaiverValidationError extends Error {
  constructor(readonly issues: readonly VerificationWaiverIssue[]) {
    super(`Verification waiver is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "VerificationWaiverValidationError";
  }
}

type WaiverLike = VerificationWaiverInput & {
  schemaVersion?: unknown;
  integrity?: { algorithm?: unknown; digest?: unknown };
};

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

function issue(
  code: VerificationWaiverIssueCode,
  path: string,
  message: string,
): VerificationWaiverIssue {
  return { code, path, message };
}

function requiredString(value: unknown, path: string): VerificationWaiverIssue | null {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    return issue("FIELD_REQUIRED", path, `${path} must be a non-empty trimmed string`);
  }
  return null;
}

function parseCanonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function validateScope(scope: unknown): VerificationWaiverIssue[] {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return [issue("FIELD_REQUIRED", "scope", "scope must be an object")];
  }
  const issues: VerificationWaiverIssue[] = [];
  const allowed = new Set<string>(VERIFICATION_WAIVER_SCOPE_DIMENSIONS);
  for (const key of Object.keys(scope)) {
    if (!allowed.has(key)) {
      issues.push(
        issue("SCOPE_DIMENSION", `scope.${key}`, `scope dimension is not allowed: ${key}`),
      );
    }
  }
  for (const dimension of VERIFICATION_WAIVER_SCOPE_DIMENSIONS) {
    const problem = requiredString(
      (scope as Record<string, unknown>)[dimension],
      `scope.${dimension}`,
    );
    if (problem) issues.push(problem);
  }
  return issues;
}

function validateActor(
  actor: unknown,
  policy: VerificationWaiverPolicy,
): VerificationWaiverIssue[] {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    return [issue("FIELD_REQUIRED", "issuedBy", "issuedBy must identify an actor")];
  }
  const candidate = actor as Record<string, unknown>;
  const issues: VerificationWaiverIssue[] = [];
  if (candidate.kind !== "human" && candidate.kind !== "service") {
    issues.push(
      issue("FIELD_REQUIRED", "issuedBy.kind", "issuedBy.kind must be human or service"),
    );
  }
  const idProblem = requiredString(candidate.id, "issuedBy.id");
  if (idProblem) issues.push(idProblem);
  if (policy.requireHumanActor && candidate.kind === "service") {
    issues.push(
      issue(
        "ACTOR_POLICY",
        "issuedBy.kind",
        "waiver policy requires attribution to a human actor",
      ),
    );
  }
  return issues;
}

function unsignedPayload(waiver: VerificationWaiverInput): string {
  // Fixed field order makes the signed bytes independent of JavaScript object insertion order.
  return JSON.stringify({
    schemaVersion: 1,
    waiverId: waiver.waiverId,
    scope: {
      tenantId: waiver.scope.tenantId,
      runId: waiver.scope.runId,
      checkId: waiver.scope.checkId,
    },
    issuedBy: {
      kind: waiver.issuedBy.kind,
      id: waiver.issuedBy.id,
    },
    reason: waiver.reason,
    issuedAt: waiver.issuedAt,
    expiresAt: waiver.expiresAt,
  });
}

function digestBytes(waiver: VerificationWaiverInput, signingKey: string | Uint8Array): Buffer {
  return createHmac("sha256", signingKey).update(unsignedPayload(waiver), "utf8").digest();
}

export function canonicalVerificationWaiverDigest(
  waiver: VerificationWaiverInput,
  signingKey: string | Uint8Array,
): string {
  return digestBytes(waiver, signingKey).toString("hex");
}

export function validateVerificationWaiver(
  waiver: WaiverLike,
  policy: VerificationWaiverPolicy = {},
): VerificationWaiverIssue[] {
  const issues: VerificationWaiverIssue[] = [];
  const waiverIdProblem = requiredString(waiver.waiverId, "waiverId");
  if (waiverIdProblem) issues.push(waiverIdProblem);
  issues.push(...validateScope(waiver.scope));
  issues.push(...validateActor(waiver.issuedBy, policy));
  const reasonProblem = requiredString(waiver.reason, "reason");
  if (reasonProblem) issues.push(reasonProblem);

  const issuedAt = parseCanonicalTimestamp(waiver.issuedAt);
  const expiresAt = parseCanonicalTimestamp(waiver.expiresAt);
  if (issuedAt === null) {
    issues.push(
      issue("TIMESTAMP_INVALID", "issuedAt", "issuedAt must be a canonical UTC timestamp"),
    );
  }
  if (expiresAt === null) {
    issues.push(
      issue("TIMESTAMP_INVALID", "expiresAt", "expiresAt must be a canonical UTC timestamp"),
    );
  }
  if (issuedAt !== null && expiresAt !== null) {
    if (expiresAt <= issuedAt) {
      issues.push(issue("EXPIRY_INVALID", "expiresAt", "expiresAt must be after issuedAt"));
    } else {
      const maxTtlMs = policy.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
      if (!Number.isFinite(maxTtlMs) || maxTtlMs <= 0 || expiresAt - issuedAt > maxTtlMs) {
        issues.push(issue("TTL_EXCEEDED", "expiresAt", "waiver exceeds the allowed lifetime"));
      }
    }
  }

  if (waiver.integrity !== undefined) {
    if (
      waiver.schemaVersion !== 1 ||
      waiver.integrity.algorithm !== "hmac-sha256" ||
      typeof waiver.integrity.digest !== "string" ||
      !DIGEST.test(waiver.integrity.digest)
    ) {
      issues.push(
        issue("INTEGRITY_INVALID", "integrity", "waiver integrity metadata is invalid"),
      );
    }
  }
  return issues;
}

export function issueVerificationWaiver(
  input: VerificationWaiverInput,
  signingKey: string | Uint8Array,
  policy: VerificationWaiverPolicy = {},
): VerificationWaiver {
  const issues = validateVerificationWaiver(input, policy);
  if (issues.length > 0) throw new VerificationWaiverValidationError(issues);
  const digest = canonicalVerificationWaiverDigest(input, signingKey);
  return Object.freeze({
    schemaVersion: 1 as const,
    waiverId: input.waiverId,
    scope: Object.freeze({ ...input.scope }),
    issuedBy: Object.freeze({ ...input.issuedBy }),
    reason: input.reason,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    integrity: Object.freeze({ algorithm: "hmac-sha256" as const, digest }),
  });
}

export function verifyVerificationWaiverDigest(
  waiver: VerificationWaiver,
  signingKey: string | Uint8Array,
): boolean {
  if (!DIGEST.test(waiver.integrity.digest)) return false;
  const supplied = Buffer.from(waiver.integrity.digest, "hex");
  const expected = digestBytes(waiver, signingKey);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function evaluateVerificationWaiver(input: {
  waiver: VerificationWaiver;
  context: VerificationWaiverEvaluationContext;
  now: Date | string;
  signingKey: string | Uint8Array;
  policy?: VerificationWaiverPolicy;
}): VerificationWaiverEvaluation {
  const issues = validateVerificationWaiver(input.waiver, input.policy);
  if (issues.length > 0) {
    return { status: "invalid", accepted: false, issues, mismatchedScope: [] };
  }
  if (!verifyVerificationWaiverDigest(input.waiver, input.signingKey)) {
    return {
      status: "tampered",
      accepted: false,
      issues: [issue("INTEGRITY_INVALID", "integrity.digest", "waiver digest does not match")],
      mismatchedScope: [],
    };
  }

  const contextIssues = validateScope(input.context);
  if (contextIssues.length > 0) {
    return { status: "invalid", accepted: false, issues: contextIssues, mismatchedScope: [] };
  }
  const mismatchedScope = VERIFICATION_WAIVER_SCOPE_DIMENSIONS.filter(
    (dimension) => input.waiver.scope[dimension] !== input.context[dimension],
  );
  if (mismatchedScope.length > 0) {
    return { status: "scope_mismatch", accepted: false, issues: [], mismatchedScope };
  }

  const now = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now);
  if (!Number.isFinite(now)) {
    return {
      status: "invalid",
      accepted: false,
      issues: [issue("TIMESTAMP_INVALID", "now", "evaluation time is invalid")],
      mismatchedScope: [],
    };
  }
  if (now < Date.parse(input.waiver.issuedAt)) {
    return { status: "not_yet_active", accepted: false, issues: [], mismatchedScope: [] };
  }
  if (now >= Date.parse(input.waiver.expiresAt)) {
    return { status: "expired", accepted: false, issues: [], mismatchedScope: [] };
  }
  return { status: "active", accepted: true, issues: [], mismatchedScope: [] };
}
