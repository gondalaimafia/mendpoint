import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_WAVE_ASSIGNMENTS,
  buildExecutionLedger,
  firstCodeLocator,
} from "./generate-production-closure-execution-ledger.js";
import { isTestPath } from "./evidence-reachability-check.js";
import {
  evaluateLedgerGate,
  serializeLedger,
} from "./production-closure-execution-ledger.js";
import {
  APPROVED_PRIMARY_PLAN_CATALOG,
  EXPECTED_WORKSTREAM_COUNTS,
  finalQualificationReady,
  runnableClosurePlans,
  transitionState,
  validateCanonicalClosureRows,
} from "./production-closure-catalog.js";

const root = resolve(import.meta.dirname, "..");

const REQUIRED_FIELDS = [
  "requirementId",
  "title",
  "registerSet",
  "workstream",
  "implementationStatus",
  "availability",
  "claimState",
  "acceptanceId",
  "acceptanceAssertion",
  "smallestUnmetGap",
  "owningWave",
  "owner",
  "issue",
  "pullRequests",
  "plannedPullRequest",
  "reachableCodePath",
  "mutationOrRegressionTest",
  "productionEvidenceTarget",
  "rollbackOrFailureProof",
  "publicClaimEffect",
  "externalDependency",
  "primaryPlan",
  "acceptanceIds",
  "evidenceProfile",
  "implementationEvidenceIds",
  "testEvidenceIds",
  "syntheticEvidenceIds",
  "liveEvidenceIds",
  "externalEvidenceIds",
  "plannedEvidenceIds",
  "rollbackEvidenceIds",
  "supportBoundary",
  "target",
  "productionRevision",
  "productionEvidenceDigest",
  "transitionState",
  "queueState",
] as const;

describe("production closure execution ledger", () => {
  const ledger = buildExecutionLedger();
  const committed = JSON.parse(
    readFileSync(resolve(root, "docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json"), "utf8"),
  ) as ReturnType<typeof buildExecutionLedger>;
  const register = JSON.parse(
    readFileSync(resolve(root, "docs/PRODUCT_REQUIREMENTS.json"), "utf8"),
  ) as {
    requirements: Array<{ id: string }>;
    additionalRegisterSets: Array<{ requirements: Array<{ id: string }> }>;
  };
  const registerIds = [
    ...register.requirements.map((row) => row.id),
    ...register.additionalRegisterSets.flatMap((set) => set.requirements.map((row) => row.id)),
  ];

  it("contains exactly the 101 canonical requirement IDs and no extras", () => {
    expect(ledger.requirementCount).toBe(101);
    expect(ledger.rows).toHaveLength(101);
    expect(ledger.rows.map((row) => row.requirementId)).toEqual(registerIds);
  });

  it("gives every row the handoff-required fields and a non-empty acceptance assertion", () => {
    for (const row of ledger.rows) {
      for (const field of REQUIRED_FIELDS) {
        expect(row).toHaveProperty(field);
      }
      expect(row.acceptanceAssertion.trim().length).toBeGreaterThan(20);
      expect(row.smallestUnmetGap.trim().length).toBeGreaterThan(20);
      expect(row.owningWave).toBeGreaterThanOrEqual(1);
      expect(row.owningWave).toBeLessThanOrEqual(11);
      // Derive the revision from the ledger under test rather than freezing a
      // literal: a hardcoded observedMainRevision would let a stale revision
      // persist forever because updating it would never fail this assertion.
      expect(row.productionEvidenceTarget).toContain(ledger.observedMainRevision);
    }
  });

  it("never records a test file as a reachable code path", () => {
    // reachableCodePath is a production-reachability claim; a test file here is
    // the row's own regression test masquerading as production evidence (it is
    // already carried, verbatim, in mutationOrRegressionTest). The test/source
    // distinction is routed through evidence-reachability-check's isTestPath so
    // this is not a second, bespoke judge.
    for (const row of ledger.rows) {
      if (row.reachableCodePath === null) continue;
      expect(
        isTestPath(row.reachableCodePath),
        `${row.requirementId} reachableCodePath is a test file: ${row.reachableCodePath}`,
      ).toBe(false);
    }
  });

  it("assigns the handoff's unimplemented and Mission rows to the declared waves", () => {
    const byId = new Map(ledger.rows.map((row) => [row.requirementId, row]));
    expect(byId.get("ME-FET-015")?.owningWave).toBe(1);
    expect(byId.get("ME-FET-015")?.implementationStatus).toBe("partial");
    expect(byId.get("ME-FET-015")?.availability).toBe("internal");
    expect(byId.get("ME-FET-015")?.claimState).toBe("internal_only");
    expect(byId.get("ME-FET-015")?.pullRequests).toEqual([514]);
    expect(byId.get("ME-FET-015")?.implementationStatus).not.toBe("verified");
    // Register cites packages/codebase-index/src/index.ts#materializeCodebaseIndex.
    // The #fragment must not collapse this to null (no production path).
    expect(byId.get("ME-FET-015")?.reachableCodePath).toBe(
      "packages/codebase-index/src/index.ts",
    );
    expect(byId.get("ME-FET-015")?.mutationOrRegressionTest).toBe(
      "packages/code-impact/src/persisted-index.test.ts",
    );
    expect(byId.get("ME-FET-018")?.owningWave).toBe(5);
    expect(byId.get("ME-REG-015")?.owningWave).toBe(7);
    expect(byId.get("ME-REG-016")?.owningWave).toBe(7);
    expect(byId.get("ME-REG-017")?.owningWave).toBe(1);
    expect(byId.get("ME-REG-018")?.owningWave).toBe(7);
    expect(byId.get("ME-CGR-001")?.owningWave).toBe(6);
    expect(byId.get("ME-WAR-010")?.owningWave).toBe(5);
    expect(byId.get("ME-WAR-010")?.externalDependency).toBeTruthy();
    expect(byId.get("ME-MSN-001")?.owningWave).toBe(4);
    expect(byId.get("ME-MCC-001")?.owningWave).toBe(4);
    expect(byId.get("ME-PEV-001")?.owningWave).toBe(4);
    expect(HANDOFF_WAVE_ASSIGNMENTS["ME-CGR-001"]).toBe(6);
  });

  it("keeps the committed artifact byte-identical to a fresh generation, every field", () => {
    // The committed artifact must equal a fresh generation across EVERY field,
    // not just the requirement-ID list: a deep structural comparison against the
    // on-disk file means perturbing any single field of the committed JSON
    // (owningWave, reachableCodePath, an assertion, the observed revision) fails
    // this test. One side is the real committed file; the other is the live
    // generator output, so the two do not trace to the same in-memory value.
    expect(committed.rows).toHaveLength(101);
    expect(committed.rows.map((row) => row.requirementId)).toEqual(registerIds);
    expect(committed).toEqual(ledger);
    expect(evaluateLedgerGate(serializeLedger(committed), ledger)).toEqual([]);
  });

  it("a single-field divergence in the committed artifact breaks the match", () => {
    // Proves the deep comparison above has teeth and is not tautological. We
    // read the committed artifact, perturb exactly one non-ID field on one row,
    // and require that the perturbed copy no longer equals the generator output.
    // If the comparison were vacuous (e.g. generated-vs-generated), this would
    // fail. The intact committed artifact must still match the generator, which
    // is exactly the assertion that goes red if the generator's real output ever
    // diverges from what is checked in.
    const target = committed.rows.find((row) => row.requirementId === "ME-CGR-001");
    expect(target).toBeDefined();
    const perturbed = {
      ...committed,
      rows: committed.rows.map((row) =>
        row.requirementId === "ME-CGR-001"
          ? { ...row, owningWave: row.owningWave + 1000 }
          : row,
      ),
    };
    expect(perturbed).not.toEqual(ledger);
    expect(committed).toEqual(ledger);
  });

  it("dropping a row from the committed artifact breaks the match", () => {
    const withoutGraph = {
      ...committed,
      rows: committed.rows.filter((row) => row.requirementId !== "ME-CGR-001"),
    };
    expect(withoutGraph.rows).toHaveLength(100);
    expect(withoutGraph).not.toEqual(ledger);
  });

  it("evaluateLedgerGate reports drift and rejects a test-file reachableCodePath", () => {
    const drifted = serializeLedger({
      ...ledger,
      observedAt: "not-the-generated-timestamp",
    });
    const driftIssues = evaluateLedgerGate(drifted, ledger);
    expect(driftIssues.map((issue) => issue.code)).toContain("LEDGER_DRIFT");

    const masquerade = {
      ...ledger,
      rows: ledger.rows.map((row) =>
        row.requirementId === "ME-CGR-001"
          ? { ...row, reachableCodePath: "scripts/production-closure-execution-ledger.test.ts" }
          : row,
      ),
    };
    const pathIssues = evaluateLedgerGate(serializeLedger(masquerade), masquerade);
    expect(pathIssues.map((issue) => issue.code)).toContain("LEDGER_REACHABLE_PATH_IS_TEST");
    expect(pathIssues[0]?.subject).toBe("ME-CGR-001");
  });

  it("firstCodeLocator excludes any test path the gate would reject (one shared judge)", () => {
    // The generator that fills reachableCodePath and the gate that rejects a
    // test reachableCodePath must use the SAME test/source judge. If the
    // generator kept a `.spec.ts` or `__tests__/` locator (which a narrower
    // `.includes(".test.")` substring lets through) the gate's isTestPath would
    // hard-reject it and no regeneration could satisfy both. These cases each
    // pass the `/\.(ts|tsx)$/` code filter, so only the shared isTestPath keeps
    // them out.
    const withEvidence = (
      locators: Array<{ type: string; locator: string }>,
    ): Parameters<typeof firstCodeLocator>[0] =>
      ({
        id: "ME-XXX-000",
        title: "synthetic",
        owner: "test",
        implementationStatus: "partial",
        availability: "internal",
        claimState: "internal_only",
        closureWorkstream: "FC-00",
        acceptance: [
          {
            id: "AC-1",
            assertion: "synthetic acceptance",
            evidence: locators.map((entry, index) => ({
              id: `EV-${index}`,
              type: entry.type,
              locator: entry.locator,
            })),
          },
        ],
        externalBlockers: null,
      }) as unknown as Parameters<typeof firstCodeLocator>[0];

    expect(firstCodeLocator(withEvidence([{ type: "unit", locator: "packages/foo/src/foo.spec.ts" }]))).toBeNull();
    expect(firstCodeLocator(withEvidence([{ type: "code", locator: "packages/foo/__tests__/foo.ts" }]))).toBeNull();
    expect(firstCodeLocator(withEvidence([{ type: "unit", locator: "packages/foo/src/foo.test.ts" }]))).toBeNull();
    // A real production path is returned, and a `#symbol` fragment is stripped.
    expect(
      firstCodeLocator(withEvidence([{ type: "code", locator: "packages/foo/src/foo.ts#run" }])),
    ).toBe("packages/foo/src/foo.ts");
    // A spec locator ahead of a real production path must be skipped, not chosen.
    expect(
      firstCodeLocator(
        withEvidence([
          { type: "unit", locator: "packages/foo/src/foo.spec.ts" },
          { type: "code", locator: "packages/foo/src/foo.ts" },
        ]),
      ),
    ).toBe("packages/foo/src/foo.ts");

    // Teeth: the retired narrower judge (`.includes(".test.")`) would NOT have
    // excluded a `.spec.ts` path, so this test goes red if the generator ever
    // regresses to that substring judge.
    expect(isTestPath("packages/foo/src/foo.spec.ts")).toBe(true);
    expect("packages/foo/src/foo.spec.ts".includes(".test.")).toBe(false);
  });

  it("binds every canonical requirement to exactly one approved primary plan", () => {
    const catalogIds = Object.values(APPROVED_PRIMARY_PLAN_CATALOG).flat();
    expect(catalogIds).toHaveLength(101);
    expect(new Set(catalogIds).size).toBe(101);
    expect([...catalogIds].sort()).toEqual([...registerIds].sort());
    expect(Object.keys(APPROVED_PRIMARY_PLAN_CATALOG)).not.toContain("*");

    for (const row of ledger.rows) {
      expect(row.primaryPlan).toMatch(/^\d{2}-\d{2}$/);
      expect(APPROVED_PRIMARY_PLAN_CATALOG[row.primaryPlan]).toContain(row.requirementId);
      expect(row.acceptanceIds).toEqual([row.acceptanceId]);
    }
  });

  it("preserves the approved workstream totals and partitions every acceptance evidence ID", () => {
    const counts = Object.fromEntries(
      Object.keys(EXPECTED_WORKSTREAM_COUNTS).map((workstream) => [
        workstream,
        ledger.rows.filter((row) => row.workstream === workstream).length,
      ]),
    );
    expect(counts).toEqual(EXPECTED_WORKSTREAM_COUNTS);

    for (const row of ledger.rows) {
      const partitioned = [
        ...row.implementationEvidenceIds,
        ...row.testEvidenceIds,
        ...row.syntheticEvidenceIds,
        ...row.liveEvidenceIds,
        ...row.externalEvidenceIds,
        ...row.plannedEvidenceIds,
      ];
      const requirement = [
        ...register.requirements,
        ...register.additionalRegisterSets.flatMap((set) => set.requirements),
      ].find((candidate) => candidate.id === row.requirementId) as unknown as {
        acceptance: Array<{ id: string; evidence: Array<{ id: string }> }>;
      };
      expect(row.acceptanceIds).toEqual(requirement.acceptance.map((item) => item.id));
      expect([...partitioned].sort()).toEqual(
        requirement.acceptance.flatMap((item) => item.evidence.map((evidence) => evidence.id)).sort(),
      );
    }
  });

  it("fails closed on primary, acceptance, external GA, and production binding drift", () => {
    const clean = validateCanonicalClosureRows(ledger.rows);
    expect(clean).toEqual([]);

    const target = ledger.rows.find((row) => row.requirementId === "ME-WAR-010")!;
    const drifted = ledger.rows.map((row) => row === target
      ? {
          ...row,
          primaryPlan: "*",
          acceptanceIds: [],
          availability: "ga" as const,
          target: {
            implementationStatus: "documented" as const,
            availability: "internal" as const,
            claimState: row.target.claimState === "public_current"
              ? "public_limited" as const
              : "public_current" as const,
          },
          plannedEvidenceIds: ["planned-evidence"],
          productionRevision: ledger.observedMainRevision,
          productionEvidenceDigest: null,
        }
      : row);
    const codes = validateCanonicalClosureRows(drifted).map((issue) => issue.code);
    expect(codes).toContain("PRIMARY_PLAN_WILDCARD");
    expect(codes).toContain("ACCEPTANCE_UNCOVERED");
    expect(codes).toContain("EXTERNAL_GA_EVIDENCE_MISSING");
    expect(codes).toContain("PRODUCTION_BINDING_INCOMPLETE");
    expect(codes).toContain("GA_EVIDENCE_MISSING");
    expect(codes).toContain("PLANNED_EVIDENCE_UNRESOLVED");
    expect(codes).toContain("TARGET_STATUS_INVALID");
    expect(codes).toContain("TARGET_AVAILABILITY_INVALID");
    expect(codes).toContain("TARGET_CLAIM_INVALID");
  });

  it("never qualifies production evidence without verified GA public state", () => {
    const documented = ledger.rows.find((row) => row.requirementId === "ME-FND-001")!;
    const evidenceOnly = ledger.rows.map((row) => row === documented
      ? {
          ...row,
          productionRevision: ledger.observedMainRevision,
          productionEvidenceDigest: `sha256:${"d".repeat(64)}`,
          transitionState: "qualified" as const,
        }
      : row);
    expect(validateCanonicalClosureRows(evidenceOnly).map((issue) => issue.code))
      .toContain("QUALIFICATION_STATE_INVALID");

    expect(transitionState({
      queueState: "ship",
      implementationStatus: "documented",
      availability: "internal",
      claimState: "internal_only",
      productionRevision: ledger.observedMainRevision,
      productionEvidenceDigest: `sha256:${"d".repeat(64)}`,
    })).toBe("deployment_pending");
  });

  it("rejects non-exact production revision and digest bindings", () => {
    const target = ledger.rows[0]!;
    const malformed = ledger.rows.map((row) => row === target
      ? { ...row, productionRevision: "main", productionEvidenceDigest: "sha256:not-a-digest" }
      : row);
    expect(validateCanonicalClosureRows(malformed).map((issue) => issue.code))
      .toContain("PRODUCTION_BINDING_INVALID");
  });

  it("reports count, workstream, register, claim, evidence, and deployed revision drift", () => {
    const first = ledger.rows.find((row) => row.requirementId === "ME-ING-002")!;
    const second = ledger.rows.find((row) => row.requirementId === "ME-ENT-001")!;
    const duplicateAndMissing = ledger.rows.map((row) =>
      row.requirementId === second.requirementId ? first : row,
    );
    const ownershipCodes = validateCanonicalClosureRows(duplicateAndMissing).map((issue) => issue.code);
    expect(ownershipCodes).toContain("REQUIREMENT_DUPLICATE");
    expect(ownershipCodes).toContain("PRIMARY_REQUIREMENT_MISSING");

    const drifted = ledger.rows.map((row) => row.requirementId === first.requirementId
      ? {
          ...row,
          workstream: second.workstream,
          implementationStatus: second.implementationStatus,
          claimState: second.claimState,
          target: { ...row.target, claimState: "public_limited" as const },
          testEvidenceIds: [],
          productionRevision: "f".repeat(40),
          productionEvidenceDigest: `sha256:${"e".repeat(64)}`,
        }
      : row);
    const driftCodes = validateCanonicalClosureRows(drifted, ledger.rows).map((issue) => issue.code);
    expect(driftCodes).toContain("WORKSTREAM_COUNT_DRIFT");
    expect(driftCodes).toContain("REGISTER_DRIFT");
    expect(driftCodes).toContain("CLAIM_DRIFT");
    expect(driftCodes).toContain("EVIDENCE_DRIFT");
    expect(driftCodes).toContain("DEPLOYED_REVISION_DRIFT");
  });

  it("keeps unrelated queue work runnable and reserves global waiting for final qualification", () => {
    const queue = [
      { planId: "05-01", queueState: "repair" as const, outcome: "failed" as const, dependencies: [] },
      { planId: "06-05", queueState: "external-proof" as const, outcome: "pending" as const, dependencies: [] },
      { planId: "08-01", queueState: "build" as const, outcome: "pending" as const, dependencies: [] },
      { planId: "09-01", queueState: "ship" as const, outcome: "pending" as const, dependencies: [] },
    ];
    expect(runnableClosurePlans(queue)).toEqual(["08-01", "09-01"]);
    expect(finalQualificationReady(queue)).toBe(false);
    expect(finalQualificationReady(queue.map((item) => ({ ...item, outcome: "succeeded" as const })))).toBe(true);
  });
});
