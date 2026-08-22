import { describe, expect, it } from "vitest";
import { assessCustomerReadiness } from "./env.js";

describe("assessCustomerReadiness", () => {
  it("reports ready only when the deployment declares ready and every precondition is met", () => {
    const assessment = assessCustomerReadiness({ MENDPOINT_CUSTOMER_READY: "1" }, []);
    expect(assessment.status).toBe("ready");
    expect(assessment.declared).toBe("ready");
    expect(assessment.reasons).toEqual([]);
  });

  it("does not report ready when a precondition is unmet, and names it", () => {
    const assessment = assessCustomerReadiness({ MENDPOINT_CUSTOMER_READY: "1" }, [
      "Customer Fettler profile requires OIDC_ISSUER",
    ]);
    expect(assessment.status).toBe("not_ready");
    expect(assessment.status).not.toBe("ready");
    expect(assessment.reasons).toContain("Customer Fettler profile requires OIDC_ISSUER");
  });

  it("does not report ready for an indeterminate declaration and names the reason", () => {
    for (const declared of [undefined, "", "maybe", "true", "2"]) {
      const env = declared === undefined ? {} : { MENDPOINT_CUSTOMER_READY: declared };
      const assessment = assessCustomerReadiness(env, []);
      expect(assessment.status).toBe("indeterminate");
      expect(assessment.status).not.toBe("ready");
      expect(assessment.reasons.some((r) => r.includes("could not be determined"))).toBe(true);
    }
  });

  it("treats a declared not-ready hold as honestly not ready, still naming preconditions", () => {
    const assessment = assessCustomerReadiness({ MENDPOINT_CUSTOMER_READY: "0" }, [
      "Customer Fettler profile requires OIDC_ISSUER",
    ]);
    expect(assessment.status).toBe("not_ready");
    expect(assessment.declared).toBe("not_ready");
    expect(assessment.reasons[0]).toContain("declares itself not ready");
    expect(assessment.reasons).toContain("Customer Fettler profile requires OIDC_ISSUER");
  });
});
