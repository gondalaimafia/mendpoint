import { describe, it, expect } from "vitest";
import { boundPrBody, MAX_PR_BODY_CHARS } from "./index.js";

describe("boundPrBody", () => {
  const coverage = "**Coverage:** `complete`";
  const evidence = "### Immutable evidence\n- Evidence record: `evidence_abc`";

  const graphBlock = [
    "### Change Graph evidence",
    "- Graph version: `graph_v1`",
    "- Context artifact: `artifact_1`",
    "",
    "```json",
    JSON.stringify({ context: "x".repeat(50_000) }),
    "```",
  ].join("\n");

  it("returns a body under the limit unchanged", () => {
    const body = [coverage, graphBlock, evidence].join("\n\n");
    expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(boundPrBody(body, graphBlock)).toBe(body);
  });

  it("drops the graph context first, stays under the limit, and keeps coverage and evidence", () => {
    // Padding so the assembled body exceeds the limit only because of the graph
    // JSON: without it the body is comfortably under the cap.
    const filler = "detail line\n".repeat(2_000);
    const body = [coverage, filler, graphBlock, evidence].join("\n\n");
    expect(body.length).toBeGreaterThan(MAX_PR_BODY_CHARS);

    const bounded = boundPrBody(body, graphBlock);
    expect(bounded.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    // States, in words, that it was shortened.
    expect(bounded).toContain("omitted to keep this PR body under GitHub's limit");
    // The oversized graph JSON payload is gone.
    expect(bounded).not.toContain("x".repeat(50_000));
    // Coverage and evidence statements survive the bounding.
    expect(bounded).toContain(coverage);
    expect(bounded).toContain(evidence);
  });

  it("falls back to an explicit truncation notice when dropping the graph context is not enough", () => {
    const huge = "y".repeat(MAX_PR_BODY_CHARS * 2);
    const bounded = boundPrBody(huge, "");
    expect(bounded.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(bounded).toContain("truncated to stay under GitHub's");
  });
});
