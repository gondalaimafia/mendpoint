import { describe, expect, it } from "vitest";
import { parsePrEvidence, REQUIRED_EVIDENCE_SECTIONS } from "./evidence";

describe("pull request evidence", () => {
  it("requires every review section before approval", () => {
    const complete = [
      "intro",
      "### Structured Fettler draft package",
      ...REQUIRED_EVIDENCE_SECTIONS.flatMap((section) => [
        `#### ${section}`,
        `${section} evidence`,
      ]),
    ].join("\n\n");
    expect(parsePrEvidence(complete)).toMatchObject({
      complete: true,
      sections: expect.arrayContaining([
        expect.objectContaining({ title: "Verification results" }),
        expect.objectContaining({ title: "Rollback" }),
        expect.objectContaining({ title: "Evidence" }),
      ]),
    });

    expect(
      parsePrEvidence("### Structured Fettler draft package\n\n#### Summary\nReady"),
    ).toMatchObject({ complete: false });
  });

  it("continues reading historical Warden draft packages", () => {
    const historical = [
      "### Structured Warden draft package",
      ...REQUIRED_EVIDENCE_SECTIONS.flatMap((section) => [
        `#### ${section}`,
        `${section} evidence`,
      ]),
    ].join("\n\n");

    expect(parsePrEvidence(historical)).toMatchObject({ complete: true });
  });
});
