import { describe, expect, it } from "vitest";
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
});
