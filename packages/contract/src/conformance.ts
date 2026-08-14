/**
 * Contract-conformance runtime (PromptSpace-style, fixture-first).
 * Spec is an executable object: schema checks, status expectations, auth probes.
 */
import { normalizeChange } from "@mendpoint/change-intel";

export type ContractCase = {
  id: string;
  name: string;
  /** Expected HTTP status (if probing) */
  expectStatus?: number;
  /** JSON body to validate against response schema shape (keys) */
  responseBody?: unknown;
  /** Required response keys */
  requiredKeys?: string[];
  /** If true, Authorization header must be present in request headers under test */
  requireAuth?: boolean;
  requestHeaders?: Record<string, string>;
};

export type ContractViolation = {
  caseId: string;
  kind:
    | "status_mismatch"
    | "schema_key_missing"
    | "auth_missing"
    | "evidence_missing"
    | "breaking_change"
    | "spec_lint";
  message: string;
  expected?: string;
  actual?: string;
};

export type ConformanceReport = {
  ok: boolean;
  violations: ContractViolation[];
  breakingSurfaces: number;
  summary: string;
};

/** Minimal JSON-shape check: required keys exist (nested via dot path optional later). */
export function checkRequiredKeys(
  body: unknown,
  keys: string[],
  caseId: string,
): ContractViolation[] {
  const out: ContractViolation[] = [];
  const obj =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!obj) {
    out.push({
      caseId,
      kind: "schema_key_missing",
      message: "response body is not an object",
    });
    return out;
  }
  for (const k of keys) {
    if (!(k in obj)) {
      out.push({
        caseId,
        kind: "schema_key_missing",
        message: `missing required key: ${k}`,
        expected: k,
      });
    }
  }
  return out;
}

export function checkAuthHeaders(
  headers: Record<string, string> | undefined,
  caseId: string,
): ContractViolation[] {
  if (!headers) {
    return [
      {
        caseId,
        kind: "auth_missing",
        message: "no request headers provided",
      },
    ];
  }
  const auth =
    headers.Authorization ??
    headers.authorization ??
    headers["X-API-Key"] ??
    headers["x-api-key"];
  if (!auth) {
    return [
      {
        caseId,
        kind: "auth_missing",
        message: "Authorization / API key header missing",
      },
    ];
  }
  return [];
}

/**
 * Run offline contract suite against recorded bodies (no network).
 * For live probes, pass results in as cases with responseBody/status.
 */
export function runContractSuite(
  cases: ContractCase[],
  opts?: { observedStatuses?: Record<string, number> },
): ConformanceReport {
  const violations: ContractViolation[] = [];
  if (!cases.length) {
    violations.push({
      caseId: "contract-suite",
      kind: "evidence_missing",
      message: "no contract cases supplied",
    });
  }
  for (const c of cases) {
    if (c.requireAuth) {
      violations.push(...checkAuthHeaders(c.requestHeaders, c.id));
    }
    if (c.requiredKeys?.length) {
      if (c.responseBody === undefined) {
        violations.push({
          caseId: c.id,
          kind: "evidence_missing",
          message: "response body evidence missing",
        });
      } else {
        violations.push(...checkRequiredKeys(c.responseBody, c.requiredKeys, c.id));
      }
    }
    if (c.expectStatus != null) {
      const actual = opts?.observedStatuses?.[c.id];
      if (actual == null) {
        violations.push({
          caseId: c.id,
          kind: "evidence_missing",
          message: `observed status missing for ${c.name}`,
          expected: String(c.expectStatus),
        });
      } else if (actual !== c.expectStatus) {
        violations.push({
          caseId: c.id,
          kind: "status_mismatch",
          message: `status mismatch for ${c.name}`,
          expected: String(c.expectStatus),
          actual: String(actual),
        });
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    breakingSurfaces: 0,
    summary: violations.length
      ? `${violations.length} contract violation(s)`
      : "contract suite passed",
  };
}

/** Breaking-change gate from two OpenAPI docs. */
export function breakingChangeGate(
  oldSpec: unknown,
  newSpec: unknown,
  providerSlug = "api",
): ConformanceReport {
  const { diff, surfaces } = normalizeChange(oldSpec as object, newSpec as object, {
    providerSlug,
  });
  const breaking = surfaces.filter(
    (s) => s.severity === "breaking" || diff.risk === "breaking",
  );
  const violations: ContractViolation[] = breaking.slice(0, 30).map((s) => ({
    caseId: s.canonicalId ?? s.id ?? "surface",
    kind: "breaking_change" as const,
    message: s.explanation || s.canonicalId || "breaking surface",
    expected: "non_breaking or approved waiver",
    actual: s.severity ?? diff.risk,
  }));
  // If risk breaking but no surface severity, still flag
  if (diff.risk === "breaking" && !violations.length) {
    violations.push({
      caseId: "diff",
      kind: "breaking_change",
      message: diff.summary,
      actual: "breaking",
    });
  }
  return {
    ok: violations.length === 0,
    violations,
    breakingSurfaces: violations.length,
    summary:
      violations.length === 0
        ? "no breaking changes detected"
        : `${violations.length} breaking surface(s): ${diff.summary}`,
  };
}

export type PrGateResult = {
  ok: boolean;
  /**
   * `verified` distinguishes gates whose result this process computed itself
   * (breaking-change diff, contract suite) from gates that are only asserted by
   * the caller and not independently confirmed here (security scan).
   */
  gates: Array<{ id: string; ok: boolean; detail: string; verified: boolean }>;
  reportMarkdown: string;
};

/** PR gate bundle: breaking-change + contract suite (+ caller-attested security). */
export function evaluatePrGates(input: {
  oldSpec?: unknown;
  newSpec?: unknown;
  providerSlug?: string;
  contractCases?: ContractCase[];
  /**
   * Caller's attestation that a security scan passed. No scanner runs in this
   * process, so this is an unverified assertion, not a verified result. Named to
   * reflect that provenance; `securityScanOk` remains accepted as a legacy alias.
   */
  securityScanAttested?: boolean;
  /** @deprecated Ambiguous name — prefer `securityScanAttested`. */
  securityScanOk?: boolean;
}): PrGateResult {
  const gates: PrGateResult["gates"] = [];

  if (input.oldSpec && input.newSpec) {
    const br = breakingChangeGate(
      input.oldSpec,
      input.newSpec,
      input.providerSlug ?? "api",
    );
    gates.push({
      id: "oas-breaking-change",
      ok: br.ok,
      detail: br.summary,
      verified: true,
    });
  } else {
    gates.push({
      id: "oas-breaking-change",
      ok: false,
      detail: "failed (no spec pair evidence)",
      verified: true,
    });
  }

  const suite = runContractSuite(input.contractCases ?? []);
  gates.push({
    id: "contract-suite",
    ok: suite.ok,
    detail: suite.summary,
    verified: true,
  });

  // Fail-closed, caller-attested only. No security scanner runs here, so a truthy
  // value is an assertion by the caller, never an independently verified result.
  const securityAttested =
    input.securityScanAttested === true || input.securityScanOk === true;
  gates.push({
    id: "security-scan",
    ok: securityAttested,
    detail: securityAttested
      ? "attested by caller — NOT independently verified (no security scanner runs in this pipeline)"
      : "no security-scan attestation supplied",
    verified: false,
  });

  const ok = gates.every((g) => g.ok);
  const hasUnverifiedPass = gates.some((g) => g.ok && !g.verified);
  const reportMarkdown = [
    "### Warden PR gates",
    "",
    ...gates.map(
      (g) =>
        `- ${g.ok ? "✅" : "❌"} **${g.id}**${g.verified ? "" : " _(attested, not verified)_"}: ${g.detail}`,
    ),
    "",
    ...(hasUnverifiedPass
      ? [
          "> ⚠️ Gates marked _(attested, not verified)_ reflect a caller-supplied assertion, not a check this pipeline ran. Treat them as unverified.",
          "",
        ]
      : []),
    ok
      ? "_All gates passed. Human review still required before merge._"
      : "_Gates failed — do not merge until fixed or waived by API owner._",
  ].join("\n");

  return { ok, gates, reportMarkdown };
}
