import { describe, expect, it } from "vitest";
import {
  classifyMigrationChange,
  type MigrationChangeKind,
} from "./compatibility.js";

describe("compatibility rule approval defaults", () => {
  const DANGEROUS_AUTO_REVIEW: MigrationChangeKind[] = [
    "rest_add_response_field",
    "rest_add_response_enum_value",
    "graphql_add_enum_value",
    "graphql_add_interface_implementation",
  ];

  it.each(DANGEROUS_AUTO_REVIEW)(
    "treats dangerous rule %s as requiring approval, not auto-executable",
    (kind) => {
      const rule = classifyMigrationChange(kind);
      expect(rule.severity).toBe("dangerous");
      expect(rule.autoExecutable).toBe(false);
      expect(rule.requiresApproval).toBe(true);
    },
  );

  it("keeps safe/additive rules auto-executable without approval", () => {
    const rule = classifyMigrationChange("rest_add_optional_request_field");
    expect(rule.severity).toBe("additive");
    expect(rule.autoExecutable).toBe(true);
    expect(rule.requiresApproval).toBe(false);
  });

  it("keeps breaking rules requiring approval and non-auto-executable", () => {
    const rule = classifyMigrationChange("rest_remove_field");
    expect(rule.severity).toBe("breaking");
    expect(rule.requiresApproval).toBe(true);
    expect(rule.autoExecutable).toBe(false);
  });

  it("preserves explicit option overrides on dangerous rules", () => {
    const rule = classifyMigrationChange("database_add_not_null_constraint");
    expect(rule.severity).toBe("dangerous");
    expect(rule.autoExecutable).toBe(false);
    expect(rule.requiresApproval).toBe(true);
  });
});
