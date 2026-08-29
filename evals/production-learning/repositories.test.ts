import { describe, expect, it } from "vitest";
import { learningCases } from "./catalog.js";
import { admissionCandidates, rejectedCandidates, repositories } from "./repositories.js";

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
