import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdaptiveSemanticReview } from "../../candidate-model.js";
import {
  AdaptiveCandidateReview,
  AdaptiveSemanticReviewPanel,
} from "./candidate-review.js";

const semanticReview: AdaptiveSemanticReview = {
  groups: [
    {
      category: "security",
      edits: [{
        path: "src/z-policy.ts",
        changeType: "modify",
        beforeContent: "export const allow = true;",
        afterContent: "export const allow = authorize(request);",
        beforeDigest: `sha256:${"a".repeat(64)}`,
        afterDigest: `sha256:${"b".repeat(64)}`,
        beforeMode: "100644",
        afterMode: "100755",
        rationale: "Require the configured authorization policy before processing.",
        risk: "high",
        confidence: 93,
        bytes: { before: 26, after: 40 },
      }],
    },
    {
      category: "tests",
      edits: [{
        path: "src/a-policy.test.ts",
        changeType: "add",
        beforeContent: null,
        afterContent: "expect(denied).toBe(true);",
        beforeDigest: `sha256:${"c".repeat(64)}`,
        afterDigest: `sha256:${"d".repeat(64)}`,
        beforeMode: null,
        afterMode: "100644",
        rationale: "Prove requests without authorization remain blocked.",
        risk: "low",
        confidence: 97,
        bytes: { before: 0, after: 27 },
      }],
    },
  ],
  verification: {
    passed: true,
    commandId: "test:policy",
    summary: "The authorization objective passed on the final candidate.",
    outputDigest: `sha256:${"e".repeat(64)}`,
  },
  overallRisk: "high",
  confidence: 93,
};

describe("Transformer adaptive candidate review", () => {
  it("renders a fail closed loading state before verified candidate evidence arrives", () => {
    const html = renderToStaticMarkup(<AdaptiveCandidateReview candidateId="candidate-a" />);

    expect(html).toContain("Loading sealed candidate");
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).not.toContain("Approve for draft delivery");
    expect(html).not.toContain("Promote");
  });

  it("renders purpose grouped before and after evidence with nearby explanations", () => {
    const html = renderToStaticMarkup(<AdaptiveSemanticReviewPanel review={semanticReview} />);

    expect(html).toContain("Why each change is proposed");
    expect(html.indexOf("Security")).toBeLessThan(html.indexOf("Tests"));
    expect(html).toContain("src/z-policy.ts");
    expect(html).toContain("Require the configured authorization policy before processing.");
    expect(html).toContain("export const allow = true;");
    expect(html).toContain("export const allow = authorize(request);");
    expect(html).toContain(`sha256:${"a".repeat(64)}`);
    expect(html).toContain(`sha256:${"b".repeat(64)}`);
    expect(html).toContain("Executable");
    expect(html).toContain("high risk");
    expect(html).toContain("93% confidence");
  });

  it("makes new file evidence and final objective verification obvious", () => {
    const html = renderToStaticMarkup(<AdaptiveSemanticReviewPanel review={semanticReview} />);

    expect(html).toContain("New file");
    expect(html).toContain("This file did not exist in the approved recipe output.");
    expect(html).toContain("Objective check passed");
    expect(html).toContain("The authorization objective passed on the final candidate.");
    expect(html).toContain("test:policy");
    expect(html).toContain(`sha256:${"e".repeat(64)}`);
  });
});
