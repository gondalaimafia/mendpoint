import { describe, expect, it } from "vitest";
import { deriveOutcomeAttribution } from "./outcome-attribution.js";

// Unit coverage for the evidence-to-attribution derivation. Each case is a
// control: the comment names the branch it protects, and deleting that branch
// changes the value this asserts. The one invariant that matters across all of
// them: `model_behavior` — the only attribution that can feed the training corpus
// — is emitted ONLY when the evidence positively confirms the model, never as a
// fallback for the undetermined.

describe("deriveOutcomeAttribution emits model_behavior only on positive model evidence", () => {
  it("verified: an objectively verified outcome is model_behavior regardless of context delivery", () => {
    expect(deriveOutcomeAttribution({ verification: "verified", contextDelivery: "recorded_present" })).toBe("model_behavior");
    expect(deriveOutcomeAttribution({ verification: "verified", contextDelivery: "recorded_absent" })).toBe("model_behavior");
    expect(deriveOutcomeAttribution({ verification: "verified", contextDelivery: "unrecorded" })).toBe("model_behavior");
  });

  it("failed + context supplied: the model had what it needed and still failed -> model_behavior", () => {
    expect(deriveOutcomeAttribution({ verification: "failed", contextDelivery: "recorded_present" })).toBe("model_behavior");
  });

  it("failed + required context absent: does NOT attribute to the model -> retrieval", () => {
    const attribution = deriveOutcomeAttribution({ verification: "failed", contextDelivery: "recorded_absent" });
    expect(attribution).toBe("retrieval");
    expect(attribution).not.toBe("model_behavior");
  });

  it("failed + context unrecorded: no observation of what the model saw -> undetermined none", () => {
    const attribution = deriveOutcomeAttribution({ verification: "failed", contextDelivery: "unrecorded" });
    expect(attribution).toBe("none");
    expect(attribution).not.toBe("model_behavior");
  });

  it("not_verified: nothing objective was established -> undetermined none, never model_behavior", () => {
    for (const contextDelivery of ["recorded_present", "recorded_absent", "unrecorded"] as const) {
      const attribution = deriveOutcomeAttribution({ verification: "not_verified", contextDelivery });
      expect(attribution).toBe("none");
      expect(attribution).not.toBe("model_behavior");
    }
  });
});
