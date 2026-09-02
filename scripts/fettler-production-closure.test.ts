import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFettlerProductionClosure,
  checkFettlerProductionClosureArtifact,
  serializeFettlerProductionClosure,
  writeFettlerProductionClosureArtifact,
} from "./fettler-production-closure.js";

describe("Fettler production closure operating contracts", () => {
  it("exposes the canonical closure check through the workspace command", () => {
    const packageManifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageManifest.scripts?.["fettler:closure:check"]).toBe(
      "tsx scripts/fettler-production-closure.ts",
    );
  });

  it("binds performance and metric definitions without claiming a measurement", () => {
    const closure = buildFettlerProductionClosure();

    expect(closure).toMatchObject({
      schemaVersion: "fettler-production-requirement-closure/1",
      product: "fettler",
      release: "production",
      operatingContracts: {
        performance: {
          version: "2026-09-02.v2",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          metricDictionaryVersion: "2026-09-02.v1",
          metricDictionaryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          evidence: {
            status: "not_observed",
            reason: "production_measurement_not_supplied",
          },
        },
        migrationCompute: {
          version: "mcu-v1",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ledgerEntryTypes: [
            "reservation",
            "settlement",
            "release",
            "adjustment",
            "credit",
          ],
          evidence: {
            status: "not_observed",
            reason: "production_ledger_not_supplied",
          },
        },
      },
    });
    expect(serializeFettlerProductionClosure()).toBe(
      `${JSON.stringify(closure, null, 2)}\n`,
    );
  });

  it("rejects missing and stale bytes and reproduces the validated artifact exactly", () => {
    const directory = mkdtempSync(join(tmpdir(), "fettler-closure-"));
    const artifactPath = join(directory, "closure.json");
    try {
      expect(() => checkFettlerProductionClosureArtifact(artifactPath))
        .toThrow("fettler_production_closure_artifact_missing");

      writeFileSync(artifactPath, "{}\n", "utf8");
      expect(() => checkFettlerProductionClosureArtifact(artifactPath))
        .toThrow("fettler_production_closure_artifact_stale");

      writeFettlerProductionClosureArtifact(artifactPath);
      expect(readFileSync(artifactPath, "utf8")).toBe(serializeFettlerProductionClosure());
      expect(() => checkFettlerProductionClosureArtifact(artifactPath)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
