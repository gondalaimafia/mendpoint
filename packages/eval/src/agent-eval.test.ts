import { describe, expect, it } from "vitest";
import { runWardenTransformerEval } from "./agent-eval.js";
import type { DelegatedPrAcceptanceReport } from "./enterprise-delegation-proof.js";

function productionReport(delegatedPrAccepted: boolean): DelegatedPrAcceptanceReport {
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: "2026-08-18.v1",
    delegatedPrAccepted,
    proofDigest: `sha256:${"1".repeat(64)}`,
    contractDigest: `sha256:${"2".repeat(64)}`,
    evidenceDigest: `sha256:${"3".repeat(64)}`,
    acceptanceDigest: `sha256:${"4".repeat(64)}`,
    verifiedAt: "2026-08-18T12:05:00.000Z",
    signerKeyIds: ["delegation-proof-key"],
    scope: {
      product: "fettler" as const,
      tenantId: "tenant-enterprise",
      repositoryId: "repo-enterprise",
      sourceRevision: "a".repeat(40),
      mendpointRevision: "b".repeat(40),
    },
    trialCount: 3,
    totalCostUsd: 1.25,
    totalDurationMs: 90_000,
    allTrialsAccepted: delegatedPrAccepted,
    findings: delegatedPrAccepted ? [] : [{
      code: "delegated_pr_cleanup_invalid",
      severity: "P0" as const,
      trial: 1,
    }],
  });
}

describe("Warden and Transformer held out evals", () => {
  it("passes observable behavior, safety, recovery, and budget graders", async () => {
    const report = await runWardenTransformerEval(1);
    expect(report.behavior.scenarioCount).toBe(46);
    expect(report.behavior.byProduct.warden.total).toBe(20);
    expect(report.behavior.byProduct.transformer.total).toBe(26);
    expect(report.behavior.byEvidenceLane).toEqual({
      contract: { passed: 42, total: 42 },
      simulated_scripted: { passed: 4, total: 4 },
      live_model: { passed: 0, total: 0 },
    });
    expect(report.behavior.criticalFailures).toEqual([]);
    expect(report.behavior.deterministicFailures).toEqual([]);
    expect(report.behavior.passAtOne).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.productionDelegation).toEqual({
      status: "not_measured",
      delegatedPrAccepted: false,
      proofDigest: null,
      contractDigest: null,
      evidenceDigest: null,
      acceptanceDigest: null,
      verifiedAt: null,
      signerKeyIds: [],
      scope: null,
    });
  }, 180_000);

  it("retains the authority verified production proof identity", async () => {
    const proof = productionReport(true);
    const report = await runWardenTransformerEval(1, proof);
    expect(report.passed).toBe(true);
    expect(report.productionDelegation).toEqual({
      status: "accepted",
      delegatedPrAccepted: true,
      proofDigest: proof.proofDigest,
      contractDigest: proof.contractDigest,
      evidenceDigest: proof.evidenceDigest,
      acceptanceDigest: proof.acceptanceDigest,
      verifiedAt: proof.verifiedAt,
      signerKeyIds: proof.signerKeyIds,
      scope: proof.scope,
    });
  }, 180_000);

  it("cannot report a passing combined evaluation with an explicit rejected production proof", async () => {
    const report = await runWardenTransformerEval(1, productionReport(false));
    expect(report.passed).toBe(false);
    expect(report.productionDelegation.status).toBe("rejected");
    expect(report.productionDelegation.delegatedPrAccepted).toBe(false);
  }, 180_000);
});
