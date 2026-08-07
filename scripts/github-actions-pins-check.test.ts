import { describe, expect, it } from "vitest";
import { findMutableActionReferences } from "./github-actions-pins-check.js";

describe("GitHub Actions pin guard", () => {
  it("accepts full commit SHAs and repository-local actions", () => {
    const source = [
      "steps:",
      "  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
      "  - uses: './.github/actions/local'",
      "  - uses: \"owner/action/path@0123456789abcdef0123456789abcdef01234567\"",
    ].join("\n");

    expect(findMutableActionReferences(source)).toEqual([]);
  });

  it("rejects tags, branches, short SHAs, expressions, and mutable container refs", () => {
    const source = [
      "steps:",
      "  - uses: actions/checkout@v5",
      "  - uses: owner/action@main",
      "  - uses: owner/action@deadbeef",
      "  - uses: owner/action@${{ github.sha }}",
      "  - uses: docker://alpine:latest",
    ].join("\n");

    expect(findMutableActionReferences(source, "ci.yml")).toEqual([
      { file: "ci.yml", line: 2, reference: "actions/checkout@v5" },
      { file: "ci.yml", line: 3, reference: "owner/action@main" },
      { file: "ci.yml", line: 4, reference: "owner/action@deadbeef" },
      { file: "ci.yml", line: 5, reference: "owner/action@${{ github.sha }}" },
      { file: "ci.yml", line: 6, reference: "docker://alpine:latest" },
    ]);
  });

  it("finds mutable references in block and flow mappings at any nesting depth", () => {
    const source = [
      "jobs:",
      "  reusable:",
      "    'uses': owner/workflows/.github/workflows/reuse.yml@main",
      "  build:",
      "    steps:",
      "      - { name: checkout, uses: actions/checkout@v5 }",
      "      - nested:",
      "          steps: [{ uses: owner/action@deadbeef }]",
    ].join("\n");

    expect(findMutableActionReferences(source, "nested.yml")).toEqual([
      {
        file: "nested.yml",
        line: 3,
        reference: "owner/workflows/.github/workflows/reuse.yml@main",
      },
      { file: "nested.yml", line: 6, reference: "actions/checkout@v5" },
      { file: "nested.yml", line: 8, reference: "owner/action@deadbeef" },
    ]);
  });

  it("fails closed on expression and non-string uses values", () => {
    const source = [
      "steps:",
      "  - uses: ${{ inputs.action }}",
      "  - uses: ./${{ inputs.local_action }}",
      "  - uses: 12345",
      "  - uses:",
      "      owner: actions/checkout",
      "      ref: v5",
    ].join("\n");

    expect(findMutableActionReferences(source, "invalid.yml")).toEqual([
      { file: "invalid.yml", line: 2, reference: "${{ inputs.action }}" },
      { file: "invalid.yml", line: 3, reference: "./${{ inputs.local_action }}" },
      { file: "invalid.yml", line: 4, reference: "12345" },
      { file: "invalid.yml", line: 5, reference: "<non-string>" },
    ]);
  });

  it("allows repository-local actions in block and flow mappings", () => {
    const source = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - { uses: './.github/actions/flow' }",
      "      - \"uses\": ./.github/actions/block",
    ].join("\n");

    expect(findMutableActionReferences(source)).toEqual([]);
  });

  it("resolves alias keys before checking action references", () => {
    const source = [
      "env:",
      "  ACTION_KEY: &action_key uses",
      "jobs:",
      "  build:",
      "    steps:",
      "      - ? *action_key",
      "        : actions/checkout@v5",
    ].join("\n");

    expect(findMutableActionReferences(source, "alias.yml")).toEqual([
      { file: "alias.yml", line: 6, reference: "actions/checkout@v5" },
    ]);
  });
});
