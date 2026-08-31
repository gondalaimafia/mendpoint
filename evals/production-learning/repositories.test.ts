import { describe, expect, it } from "vitest";
import { learningCases } from "./catalog.js";
import { admissionCandidates, rejectedCandidates, repositories, repositoryScreeningEvidenceState } from "./repositories.js";
import type { RepositoryProvenance } from "./schema.js";

describe("repository provenance candidates", () => {
  it("records immutable license evidence for every candidate", () => {
    expect(admissionCandidates).toHaveLength(10);
    for (const candidate of admissionCandidates) {
      expect(candidate.immutableCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(candidate.license.textSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(candidate.license.intendedUses).toEqual(expect.arrayContaining(["evaluation", "governed_learning"]));
      expect(candidate.contentScreening).toEqual({
        secrets: "unknown",
        personalData: "unknown",
        generatedCredentials: "unknown",
        customerData: "unknown",
      });
    }
  });

  it("admits no repository until exact clone screening is complete", () => {
    expect(repositories).toEqual([]);
  });

  it("keeps archived and unresolved license candidates visibly conditional or rejected", () => {
    const archived = admissionCandidates.find((candidate) => candidate.id === "repo-dotnet-architecture-eshoponweb");
    expect(archived?.admission).toMatchObject({ state: "conditional", archived: true });
    expect(rejectedCandidates.map((candidate) => candidate.repositoryUrl)).toEqual(expect.arrayContaining([
      "https://github.com/django/django",
      "https://github.com/fastapi/fastapi",
      "https://github.com/tokio-rs/tokio",
    ]));
  });

  it("labels substitute repositories as synthetic substrates rather than native provenance", () => {
    const reviewedIds = new Set(admissionCandidates.map((candidate) => candidate.id));
    const nativeBindings = learningCases.filter((item) => item.repository.binding.mode === "native");
    const syntheticBindings = learningCases.filter((item) => item.repository.binding.mode === "synthetic_substrate");
    expect(nativeBindings).toHaveLength(52);
    expect(syntheticBindings).toHaveLength(98);
    expect(nativeBindings.length + syntheticBindings.length).toBe(150);
    for (const item of learningCases) {
      expect(reviewedIds.has(item.repository.provenanceId)).toBe(true);
      expect(item.repository.binding.originalResearchCandidate.length).toBeGreaterThan(0);
      expect(item.repository.binding.rationale.length).toBeGreaterThan(0);
    }
    for (const originalResearchCandidate of [
      "repo-slackapi-node-slack-sdk",
      "repo-twilio-twilio-node",
      "repo-expressjs-express",
      "repo-apache-kafka",
    ]) {
      expect(learningCases.filter((item) => item.repository.binding.originalResearchCandidate === originalResearchCandidate))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ repository: expect.objectContaining({ binding: expect.objectContaining({ mode: "synthetic_substrate" }) }) }),
        ]));
      expect(learningCases.filter((item) => item.repository.binding.originalResearchCandidate === originalResearchCandidate)
        .every((item) => item.repository.binding.mode === "synthetic_substrate")).toBe(true);
    }
  });
});

describe("repository screening evidence state", () => {
  function admitted(
    screening: Partial<RepositoryProvenance["contentScreening"]> = {},
  ): RepositoryProvenance {
    return {
      schemaVersion: "mendpoint.repository-provenance.v1",
      id: "repo-example",
      repositoryUrl: "https://github.com/example/example",
      immutableCommit: "e".repeat(40),
      license: {
        spdxId: "MIT",
        sourceUrl: "https://github.com/example/example/blob/main/LICENSE",
        textSha256: "4".repeat(64),
        decision: "approved",
        decidedAt: "2026-08-28T23:00:00.000Z",
        intendedUses: ["evaluation", "governed_learning"],
      },
      languages: ["TypeScript"],
      frameworks: ["Node.js"],
      dependencyLockfiles: ["package-lock.json"],
      provenanceRetrievedAt: "2026-08-28T23:00:00.000Z",
      dataClassification: "public_source_code",
      contentScreening: {
        secrets: "not_detected",
        personalData: "not_detected",
        generatedCredentials: "not_detected",
        customerData: "not_present",
        ...screening,
      },
    };
  }

  it("reports unknown while nothing has been admitted", () => {
    // The state the program is actually in: zero admitted, ten candidates. The
    // previous count comparison also returned "unknown" here, but only because
    // 0 !== 10; with an empty candidate list it would have claimed "verified"
    // for a program that had screened nothing at all.
    expect(repositoryScreeningEvidenceState(repositories, admissionCandidates)).toEqual("unknown");
    expect(repositoryScreeningEvidenceState([], [])).toEqual("unknown");
  });

  it("reports unknown when an admitted repository has not been screened", () => {
    // The latent defect this replaced. Counts match, so the old expression said
    // "verified" while every screening axis was still unknown.
    const unscreened = [admitted({ secrets: "unknown", personalData: "unknown", generatedCredentials: "unknown", customerData: "unknown" })];
    expect(unscreened).toHaveLength(1);
    expect(repositoryScreeningEvidenceState(unscreened, [unscreened[0]! as never])).toEqual("unknown");
  });

  it("reports unknown when screening detected a finding", () => {
    for (const screening of [
      { secrets: "detected" },
      { personalData: "detected" },
      { generatedCredentials: "detected" },
      { customerData: "present" },
    ] as const) {
      const repository = [admitted(screening)];
      expect(repositoryScreeningEvidenceState(repository, [repository[0]! as never])).toEqual("unknown");
    }
  });

  it("reports verified only when every admitted repository screened clean and every candidate was admitted", () => {
    const clean = [admitted()];
    expect(repositoryScreeningEvidenceState(clean, [clean[0]! as never])).toEqual("verified");
    // One candidate still outstanding leaves the verdict unknown.
    expect(repositoryScreeningEvidenceState(clean, [clean[0]! as never, clean[0]! as never])).toEqual("unknown");
  });
});
