import type { CandidateReviewEvidence } from "@mendpoint/shared";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CandidateReviewEvidencePanel } from "./candidate-review-evidence.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("Fettler candidate review evidence", () => {
  it("renders every precise version two authority field before review", () => {
    const evidence: CandidateReviewEvidence = {
      schemaVersion: 2,
      summary: "Update the parser without widening its accepted input.",
      verification: {
        summary: "The approved parser checks passed.",
        commands: [{ command: "npm test -- parser", ok: true, exitCode: 0, outputSha256: digest }],
      },
      edits: [{
        path: "src/parser.ts",
        hypothesis: "The decoder rejects the new bounded input shape.",
        targetSymbol: "decodeRequest",
        sourceEvidence: [{ path: "src/schema.ts", digest }],
        precondition: "The request has already passed the shared size limit.",
        expectedObservation: "The new fixture parses successfully.",
        postcondition: "Existing invalid fixtures remain rejected.",
        rollback: "Restore the previous decoder implementation.",
        stopCondition: "Stop if any existing invalid fixture becomes accepted.",
        risk: "medium",
        confidence: 0.91,
        assessmentSource: "planner",
        verification: {
          summary: "Parser regression suite passed.",
          commandOutputSha256: [digest],
        },
      }],
    };

    const html = renderToStaticMarkup(<CandidateReviewEvidencePanel evidence={evidence} />);

    for (const expected of [
      "Precise review evidence",
      "Update the parser without widening its accepted input.",
      "src/parser.ts",
      "The decoder rejects the new bounded input shape.",
      "decodeRequest",
      "src/schema.ts",
      digest,
      "The request has already passed the shared size limit.",
      "The new fixture parses successfully.",
      "Existing invalid fixtures remain rejected.",
      "Restore the previous decoder implementation.",
      "Stop if any existing invalid fixture becomes accepted.",
      "Medium",
      "91 percent",
      "Planner",
      "Parser regression suite passed.",
      "npm test -- parser",
    ]) expect(html).toContain(expected);
  });

  it("keeps version one evidence readable", () => {
    const evidence: CandidateReviewEvidence = {
      schemaVersion: 1,
      summary: "Preserve the public API.",
      verification: {
        summary: "All approved checks passed.",
        commands: [{ command: "npm test", ok: true, exitCode: 0, outputSha256: digest }],
      },
      edits: [{
        path: "src/index.ts",
        rationale: "Keep the exported signature stable.",
        category: "compatibility",
        risk: "low",
        confidence: 0.8,
        assessmentSource: "planner",
        verification: { summary: "API tests passed.", commandOutputSha256: [digest] },
      }],
    };

    const html = renderToStaticMarkup(<CandidateReviewEvidencePanel evidence={evidence} />);

    expect(html).toContain("Review evidence");
    expect(html).toContain("Keep the exported signature stable.");
    expect(html).toContain("Compatibility");
    expect(html).toContain("80 percent");
    expect(html).not.toContain("Precise review evidence");
  });
});
