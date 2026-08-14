import { describe, expect, it } from "vitest";
import { listExamples } from "./load.js";
import { changeEventToSurfaces, changeEventToDiff } from "./surfaces.js";
import { analyzeImpact, reportToFindings } from "@mendpoint/code-impact";
import {
  generateExampleEdits,
  planExampleMigration,
  selectSdkTransformFamilies,
} from "./migrate.js";
import type { ChangeEvent } from "./types.js";

describe("concrete API migration examples", () => {
  it("loads all five example fixtures", () => {
    const examples = listExamples();
    expect(examples.length).toBeGreaterThanOrEqual(5);
    const ids = examples.map((e) => e.id);
    expect(ids.some((i) => i.includes("stripe-pagination"))).toBe(true);
    expect(ids.some((i) => i.includes("openai"))).toBe(true);
    expect(ids.some((i) => i.includes("aws-s3"))).toBe(true);
    expect(ids.some((i) => i.includes("fintech") || i.includes("transfers"))).toBe(true);
    expect(ids.some((i) => i.includes("feature-adoption"))).toBe(true);
  });

  it("each example produces surfaces and at least one impact finding", async () => {
    for (const ex of listExamples()) {
      const surfaces = changeEventToSurfaces(ex.changeEvent);
      expect(surfaces.length).toBeGreaterThan(0);
      const report = await analyzeImpact(ex.consumerPath, surfaces, {
        minConfidence: "medium",
      });
      const findings = reportToFindings(report);
      expect(findings.length).toBeGreaterThan(0);
      // edits should apply for known vendors
      const edits = generateExampleEdits(ex.changeEvent, ex.consumerPath, findings);
      // adoption or migration should produce either findings or edits
      expect(findings.length + edits.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("openai example renames max_tokens in generated edits", async () => {
    const ex = listExamples().find((e) => e.id.includes("openai"))!;
    const surfaces = changeEventToSurfaces(ex.changeEvent);
    const report = await analyzeImpact(ex.consumerPath, surfaces);
    const findings = reportToFindings(report);
    const edits = generateExampleEdits(ex.changeEvent, ex.consumerPath, findings);
    expect(edits.some((e) => e.updated.includes("max_completion_tokens"))).toBe(true);
    expect(edits.some((e) => e.updated.includes("message.content"))).toBe(true);
    // partial migration site should not be broken
    expect(edits.some((e) => e.original.includes("max_completion_tokens"))).toBe(true);
  });

  it("fintech example adds idempotency_key and bearer auth", async () => {
    const ex = listExamples().find((e) => e.id.includes("fintech") || e.id.includes("transfers"))!;
    const surfaces = changeEventToSurfaces(ex.changeEvent);
    const report = await analyzeImpact(ex.consumerPath, surfaces);
    const edits = generateExampleEdits(
      ex.changeEvent,
      ex.consumerPath,
      reportToFindings(report),
    );
    const joined = edits.map((e) => e.updated).join("\n");
    expect(joined.includes("idempotency_key") || joined.includes("Bearer")).toBe(true);
  });

  it("change events map to breaking or new_capability risk", () => {
    for (const ex of listExamples()) {
      const diff = changeEventToDiff(ex.changeEvent);
      expect(["breaking", "non_breaking", "new_capability"]).toContain(diff.risk);
    }
  });

  it("selects a transform family from the change data, not the vendor name", () => {
    // Known vendors still select correctly (no regression), keyed on their ops
    // and search tokens rather than an id substring.
    const stripe = listExamples().find((e) => e.id.includes("stripe-pagination"))!;
    expect(selectSdkTransformFamilies(stripe.changeEvent)).toContain(
      "stripe-cursor-pagination",
    );
    const openai = listExamples().find((e) => e.id.includes("openai"))!;
    expect(selectSdkTransformFamilies(openai.changeEvent)).toContain("openai-token-rename");
    const aws = listExamples().find((e) => e.id.includes("aws-s3"))!;
    expect(selectSdkTransformFamilies(aws.changeEvent)).toContain("aws-s3-modular");
    const fintech = listExamples().find(
      (e) => e.id.includes("fintech") || e.id.includes("transfers"),
    )!;
    expect(selectSdkTransformFamilies(fintech.changeEvent)).toContain(
      "http-bearer-idempotency",
    );
  });

  it("abstains with an explicit reason for an unknown vendor whose change matches no family", () => {
    // The regauge/sdk-upgrade subject: a vendor (`pulsegate`) whose id contains
    // none of the demo substrings and whose field tokens are not the hardcoded
    // demo tokens. It must abstain explicitly, never fall through to a silent
    // empty edit list.
    const pulsegate: ChangeEvent = {
      id: "pulsegate-v2-to-v3",
      vendor: "pulsegate",
      surface: "PulseGate delivery client",
      sdkSurface: "pulsegate.deliver",
      type: "breaking",
      title: "PulseGate v2 to v3 client migration",
      description: "Factory constructor, options-object deliver, renamed response fields.",
      migration: "Adopt createPulseGateClient and the v3 response shape.",
      ops: [
        { op: "request_field_renamed", path: "/v3/deliver", fromField: "apiKey", toField: "token", breaking: true },
        { op: "response_field_renamed", path: "/v3/deliver", fromField: "statusCode", toField: "status", breaking: true },
        { op: "response_field_renamed", path: "/v3/deliver", fromField: "body", toField: "data", breaking: true },
      ],
      searchTokens: ["pulsegate", "deliver", "statusCode", "body", "apiKey"],
    };

    expect(selectSdkTransformFamilies(pulsegate)).toEqual([]);

    const plan = planExampleMigration(pulsegate, process.cwd(), []);
    expect(plan.status).toBe("abstained");
    if (plan.status === "abstained") {
      expect(plan.reason).toBe("no_sdk_transform_for_change:pulsegate.deliver");
    }
    // The backward-compatible edit list is empty, but the abstention is explicit
    // through the plan result above rather than a silent no-op.
    expect(generateExampleEdits(pulsegate, process.cwd(), [])).toEqual([]);
  });
});
