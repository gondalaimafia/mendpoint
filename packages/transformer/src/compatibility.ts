export type CompatibilityDimension =
  | "source"
  | "wire"
  | "semantic"
  | "state"
  | "security"
  | "operational";

export type MigrationSeverity = "additive" | "dangerous" | "breaking" | "security_required";

export type MigrationChangeKind =
  | "rest_add_optional_request_field"
  | "rest_add_response_field"
  | "rest_remove_field"
  | "rest_rename_field"
  | "rest_add_required_request_field"
  | "rest_change_field_type"
  | "rest_change_default"
  | "rest_reduce_pagination_default"
  | "rest_add_response_enum_value"
  | "rest_change_auth_requirement"
  | "graphql_add_field"
  | "graphql_remove_field"
  | "graphql_add_enum_value"
  | "graphql_add_interface_implementation"
  | "graphql_nullable_to_non_null"
  | "protobuf_add_optional_field"
  | "protobuf_change_field_number"
  | "protobuf_move_definition_file"
  | "protobuf_change_field_type"
  | "database_add_nullable_column"
  | "database_add_not_null_constraint"
  | "database_rename_column"
  | "database_change_column_type"
  | "dependency_major_upgrade"
  | "runtime_major_upgrade"
  | "kubernetes_remove_api_version"
  | "kubernetes_advance_storage_version"
  | "terraform_change_state_schema"
  | "webhook_remove_payload_field"
  | "webhook_change_signature_scheme"
  | "oauth_remove_insecure_flow"
  | "oauth_expand_scope";

export type CompatibilityRule = {
  kind: MigrationChangeKind;
  severity: MigrationSeverity;
  dimensions: CompatibilityDimension[];
  reason: string;
  rollout: Array<"expand" | "backfill" | "migrate" | "observe" | "contract">;
  requiresApproval: boolean;
  autoExecutable: boolean;
  sourceRef: string;
};

const HTTP_SOURCE = "https://www.rfc-editor.org/rfc/rfc9110.html";
const GOOGLE_COMPAT_SOURCE = "https://google.aip.dev/180";
const GITHUB_VERSION_SOURCE =
  "https://docs.github.com/en/rest/about-the-rest-api/api-versions";
const GRAPHQL_SOURCE = "https://graphql.org/learn/governance-versioning/";
const PROTOBUF_SOURCE = "https://protobuf.dev/programming-guides/proto3/";
const POSTGRES_SOURCE = "https://www.postgresql.org/docs/17/sql-altertable.html";
const KUBERNETES_SOURCE = "https://kubernetes.io/docs/reference/using-api/deprecation-policy/";
const TERRAFORM_SOURCE =
  "https://developer.hashicorp.com/terraform/plugin/framework/resources/state-upgrade";
const OAUTH_SOURCE = "https://www.rfc-editor.org/info/rfc9700/";

function rule(
  kind: MigrationChangeKind,
  severity: MigrationSeverity,
  dimensions: CompatibilityDimension[],
  reason: string,
  sourceRef: string,
  options: Partial<Pick<CompatibilityRule, "rollout" | "requiresApproval" | "autoExecutable">> = {},
): CompatibilityRule {
  const breaking = severity === "breaking" || severity === "security_required";
  // "dangerous" changes are not breaking, but their own reason strings say they
  // can break exhaustive/strict clients, so they must default to human review
  // rather than silently auto-executing.
  const requiresReview = breaking || severity === "dangerous";
  return {
    kind,
    severity,
    dimensions,
    reason,
    rollout: options.rollout ?? (breaking
      ? ["expand", "migrate", "observe", "contract"]
      : ["expand", "observe"]),
    requiresApproval: options.requiresApproval ?? requiresReview,
    autoExecutable: options.autoExecutable ?? !requiresReview,
    sourceRef,
  };
}

export const MIGRATION_COMPATIBILITY_RULES: readonly CompatibilityRule[] = [
  rule("rest_add_optional_request_field", "additive", ["source", "wire"], "An optional request field preserves old clients when its default behavior is unchanged.", GOOGLE_COMPAT_SOURCE),
  rule("rest_add_response_field", "dangerous", ["source", "wire", "semantic"], "Some strict clients reject unknown response fields even when the wire format permits them.", GITHUB_VERSION_SOURCE),
  rule("rest_remove_field", "breaking", ["source", "wire", "semantic"], "Removing a field breaks clients that compile against or read it.", GITHUB_VERSION_SOURCE),
  rule("rest_rename_field", "breaking", ["source", "wire", "semantic"], "A rename is a removal plus an addition and requires a compatibility window.", GOOGLE_COMPAT_SOURCE),
  rule("rest_add_required_request_field", "breaking", ["source", "wire", "semantic"], "Old clients cannot supply a newly required request field.", GITHUB_VERSION_SOURCE),
  rule("rest_change_field_type", "breaking", ["source", "wire", "semantic"], "A field type change can fail compilation, serialization, and runtime assumptions.", GOOGLE_COMPAT_SOURCE),
  rule("rest_change_default", "breaking", ["semantic"], "Changing a default alters behavior for clients that omit the value.", GOOGLE_COMPAT_SOURCE),
  rule("rest_reduce_pagination_default", "breaking", ["semantic", "operational"], "Older clients may treat the first page as the complete result set.", GOOGLE_COMPAT_SOURCE),
  rule("rest_add_response_enum_value", "dangerous", ["source", "semantic"], "Exhaustive clients may not handle a new response enum value.", GOOGLE_COMPAT_SOURCE),
  rule("rest_change_auth_requirement", "breaking", ["security", "wire", "operational"], "Authentication changes require coordinated credentials and must not create a downgrade path.", GITHUB_VERSION_SOURCE, { autoExecutable: false }),
  rule("graphql_add_field", "additive", ["source", "wire"], "Existing GraphQL operations do not select a newly added field.", GRAPHQL_SOURCE),
  rule("graphql_remove_field", "breaking", ["source", "wire", "semantic"], "Removing a selected field invalidates existing operations.", GRAPHQL_SOURCE),
  rule("graphql_add_enum_value", "dangerous", ["source", "semantic"], "Generated and exhaustive clients can fail on an unknown enum value.", GRAPHQL_SOURCE),
  rule("graphql_add_interface_implementation", "dangerous", ["source", "semantic"], "Existing exhaustive fragments may not account for a new implementation type.", GRAPHQL_SOURCE),
  rule("graphql_nullable_to_non_null", "breaking", ["wire", "semantic"], "A stronger nullability contract can invalidate variables and alter error propagation.", GRAPHQL_SOURCE),
  rule("protobuf_add_optional_field", "additive", ["wire"], "Old binary readers ignore an unknown optional field.", PROTOBUF_SOURCE),
  rule("protobuf_change_field_number", "breaking", ["wire", "state"], "Field numbers are wire identities and cannot be reassigned safely.", PROTOBUF_SOURCE, { autoExecutable: false }),
  rule("protobuf_move_definition_file", "breaking", ["source"], "Generated imports can break even when the wire representation is unchanged.", GOOGLE_COMPAT_SOURCE),
  rule("protobuf_change_field_type", "breaking", ["source", "wire", "semantic"], "Wire compatible type pairs can still break generated source and JSON behavior.", PROTOBUF_SOURCE, { autoExecutable: false }),
  rule("database_add_nullable_column", "additive", ["state", "operational"], "A nullable column can be introduced before writers and readers adopt it.", POSTGRES_SOURCE, { rollout: ["expand", "backfill", "migrate", "observe"] }),
  rule("database_add_not_null_constraint", "dangerous", ["state", "operational"], "Existing rows and table scans require a staged validation plan.", POSTGRES_SOURCE, { rollout: ["expand", "backfill", "migrate", "observe", "contract"], requiresApproval: true, autoExecutable: false }),
  rule("database_rename_column", "breaking", ["source", "state", "semantic"], "A direct rename breaks old binaries and rollback readers.", POSTGRES_SOURCE, { rollout: ["expand", "backfill", "migrate", "observe", "contract"], autoExecutable: false }),
  rule("database_change_column_type", "breaking", ["source", "state", "semantic", "operational"], "A type rewrite can lose data, lock tables, and make rollback unreadable.", POSTGRES_SOURCE, { rollout: ["expand", "backfill", "migrate", "observe", "contract"], autoExecutable: false }),
  rule("dependency_major_upgrade", "breaking", ["source", "semantic", "operational"], "A major dependency can change its declared public API and runtime behavior.", "https://semver.org/", { autoExecutable: false }),
  rule("runtime_major_upgrade", "breaking", ["source", "semantic", "operational"], "A runtime upgrade requires the full build and behavior matrix for every supported target.", "https://semver.org/", { autoExecutable: false }),
  rule("kubernetes_remove_api_version", "breaking", ["wire", "state", "operational"], "Stored objects and older clients require a served conversion path before removal.", KUBERNETES_SOURCE, { autoExecutable: false }),
  rule("kubernetes_advance_storage_version", "dangerous", ["state", "operational"], "The old and new version must coexist before storage advances so rollback remains possible.", KUBERNETES_SOURCE, { rollout: ["expand", "migrate", "observe", "contract"], requiresApproval: true, autoExecutable: false }),
  rule("terraform_change_state_schema", "dangerous", ["state", "operational"], "Every prior persisted state shape needs a tested upgrader.", TERRAFORM_SOURCE, { requiresApproval: true, autoExecutable: false }),
  rule("webhook_remove_payload_field", "breaking", ["wire", "semantic", "operational"], "Webhook consumers can process delayed or replayed events using the older payload.", HTTP_SOURCE, { autoExecutable: false }),
  rule("webhook_change_signature_scheme", "breaking", ["security", "wire", "operational"], "Signature rotation needs overlap without accepting unsigned or downgraded deliveries.", HTTP_SOURCE, { autoExecutable: false }),
  rule("oauth_remove_insecure_flow", "security_required", ["security", "wire", "operational"], "Security guidance can require an interoperability break and must not preserve the insecure flow.", OAUTH_SOURCE, { autoExecutable: false }),
  rule("oauth_expand_scope", "security_required", ["security", "semantic"], "A broader scope changes privilege and requires explicit human approval.", OAUTH_SOURCE, { rollout: ["expand", "migrate", "observe"], autoExecutable: false }),
] as const;

const RULE_BY_KIND = new Map(MIGRATION_COMPATIBILITY_RULES.map((entry) => [entry.kind, entry]));

export function classifyMigrationChange(kind: MigrationChangeKind): CompatibilityRule {
  const found = RULE_BY_KIND.get(kind);
  if (!found) throw new Error(`Unsupported migration change kind: ${kind}`);
  return { ...found, dimensions: [...found.dimensions], rollout: [...found.rollout] };
}
