import { createHash } from "node:crypto";
import { assessTransformerGate } from "@mendpoint/ops";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type RegaugeProductionBootstrapInput = {
  tenantId: string;
  campaignId: string;
  environment: string;
  repository: {
    owner: string;
    name: string;
    remoteRepositoryId: string;
    defaultBranch: string;
    selectedBranch: string;
    expectedRevision: string;
    installationId: string;
    accountId: string;
    accountLogin: string;
  };
  plannerActorId: string;
  reviewer: {
    issuer: string;
    subject: string;
    displayName: string;
    email: string | null;
  };
  objective: {
    id: string;
    statement: string;
    sourceSystem: string;
    targetSystem: string;
  };
  gateConfig: string;
  productionApprovalRef: string;
  evidenceRefs: string[];
};

export type RegaugeProductionRepositoryAuthority = Readonly<{
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
}>;

export type RegaugeProductionControl = Readonly<{
  campaignId: string;
  campaignState: "draft" | "ready";
  campaignRevision: number;
  blueprintId: string;
  blueprintDigest: string;
  blueprintState: "draft" | "reviewed";
  blueprintRevision: number;
  bsgRevision: number;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  plannerActorId: string;
  reviewerActorIds: readonly string[];
  sourceSystem: string;
  targetSystem: string;
  objectiveStatement: string;
}>;

export type RegaugeProductionExecution = Readonly<{
  campaignId: string;
  state: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  blueprintId: string;
  blueprintDigest: string;
}>;

export type RegaugeProductionBootstrapReceipt = Readonly<{
  schemaVersion: "2026-08-14.v1";
  requestDigest: string;
  tenantId: string;
  campaignId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  blueprintId: string;
  blueprintDigest: string;
  state: string;
  eventHash: string;
}>;

export type RegaugeProductionPlanRequest = Readonly<{
  tenantId: string;
  campaignId: string;
  environment: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotDigest: string;
  plannerActorId: string;
  reviewerActorId: string;
  objective: RegaugeProductionBootstrapInput["objective"];
  evidenceRefs: readonly string[];
  requestDigest: string;
}>;

export type RegaugeProductionBootstrapRuntime = Readonly<{
  prepareRepository(input: Readonly<{
    bootstrap: RegaugeProductionBootstrapInput;
    reviewerActorId: string;
    requestDigest: string;
  }>): Promise<RegaugeProductionRepositoryAuthority>;
  readControl(tenantId: string, campaignId: string): Promise<RegaugeProductionControl | undefined>;
  plan(input: RegaugeProductionPlanRequest): Promise<RegaugeProductionControl>;
  review(input: Readonly<{
    tenantId: string;
    campaignId: string;
    reviewerActorId: string;
    evidenceRefs: readonly string[];
    requestDigest: string;
    control: RegaugeProductionControl;
  }>): Promise<RegaugeProductionControl>;
  readExecution(tenantId: string, campaignId: string): Promise<RegaugeProductionExecution | undefined>;
  launch(input: Readonly<{
    tenantId: string;
    campaignId: string;
    reviewerActorId: string;
    evidenceRefs: readonly string[];
    requestDigest: string;
    control: RegaugeProductionControl;
  }>): Promise<RegaugeProductionExecution>;
  readReceipt(tenantId: string, campaignId: string): Promise<RegaugeProductionBootstrapReceipt | undefined>;
  recordReceipt(input: Omit<RegaugeProductionBootstrapReceipt, "eventHash">): Promise<RegaugeProductionBootstrapReceipt>;
}>;

function codeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => codeUnit(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function text(value: unknown, code: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(code);
  }
  return value.trim();
}

function identifier(value: unknown, code: string): string {
  const normalized = text(value, code, 200);
  if (!ID.test(normalized)) throw new Error(code);
  return normalized;
}

function actor(value: unknown, code: string): string {
  const normalized = text(value, code, 500);
  if (!/^(?:service|human|api-key):[^\x00-\x1f\x7f]{1,480}$/.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function repositoryPart(value: unknown, code: string): string {
  const normalized = text(value, code, 100);
  if (normalized === "." || normalized === ".." || !REPOSITORY_PART.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function normalize(input: RegaugeProductionBootstrapInput): Readonly<{
  bootstrap: RegaugeProductionBootstrapInput;
  reviewerActorId: string;
  requestDigest: string;
}> {
  const tenantId = identifier(input.tenantId, "regauge_production_bootstrap_tenant_invalid");
  const campaignId = identifier(input.campaignId, "regauge_production_bootstrap_campaign_invalid");
  const environment = identifier(input.environment, "regauge_production_bootstrap_environment_invalid");
  if (environment !== "production") throw new Error("regauge_production_bootstrap_environment_invalid");
  const owner = repositoryPart(input.repository?.owner, "regauge_production_bootstrap_repository_invalid");
  const name = repositoryPart(input.repository?.name, "regauge_production_bootstrap_repository_invalid");
  const remoteRepositoryId = text(input.repository?.remoteRepositoryId, "regauge_production_bootstrap_repository_invalid", 20);
  const installationId = text(input.repository?.installationId, "regauge_production_bootstrap_installation_invalid", 20);
  const accountId = text(input.repository?.accountId, "regauge_production_bootstrap_account_invalid", 20);
  if (![remoteRepositoryId, installationId, accountId].every((value) => NUMERIC_ID.test(value))) {
    throw new Error("regauge_production_bootstrap_repository_invalid");
  }
  const defaultBranch = text(input.repository?.defaultBranch, "regauge_production_bootstrap_branch_invalid", 255);
  const selectedBranch = text(input.repository?.selectedBranch, "regauge_production_bootstrap_branch_invalid", 255);
  const expectedRevision = text(input.repository?.expectedRevision, "regauge_production_bootstrap_revision_invalid", 40);
  if (!REVISION.test(expectedRevision)) throw new Error("regauge_production_bootstrap_revision_invalid");
  const plannerActorId = actor(input.plannerActorId, "regauge_production_bootstrap_planner_invalid");
  const issuer = text(input.reviewer?.issuer, "regauge_production_bootstrap_reviewer_invalid", 300);
  const subject = text(input.reviewer?.subject, "regauge_production_bootstrap_reviewer_invalid", 300);
  const reviewerActorId = `human:${issuer}|${subject}`;
  if (plannerActorId === reviewerActorId) {
    throw new Error("regauge_production_bootstrap_independent_reviewer_required");
  }
  const evidenceRefs = [...new Set(input.evidenceRefs.map((value) =>
    identifier(value, "regauge_production_bootstrap_evidence_invalid")))].sort(codeUnit);
  if (evidenceRefs.length !== input.evidenceRefs.length || evidenceRefs.length === 0) {
    throw new Error("regauge_production_bootstrap_evidence_invalid");
  }
  const productionApprovalRef = identifier(
    input.productionApprovalRef,
    "regauge_production_bootstrap_approval_invalid",
  );
  if (!evidenceRefs.includes(productionApprovalRef)) {
    throw new Error("regauge_production_bootstrap_approval_invalid");
  }
  const gate = assessTransformerGate({
    tenantId,
    environment,
    boundary: "delivery",
    productionDeliveryApprovalRefs: [productionApprovalRef],
  }, text(input.gateConfig, "regauge_production_bootstrap_gate_invalid", 100_000));
  if (!gate.allowed) throw new Error("regauge_production_bootstrap_gate_denied");
  const expectedApprovalPrefix = [
    "approval:regauge",
    tenantId,
    campaignId,
    "repository",
    remoteRepositoryId,
    "revision",
    expectedRevision,
    "draft:1:run:",
  ].join(":");
  const approvalSuffix = productionApprovalRef.slice(expectedApprovalPrefix.length);
  if (!productionApprovalRef.startsWith(expectedApprovalPrefix) ||
      !/^[1-9][0-9]*:attempt:[1-9][0-9]*$/.test(approvalSuffix)) {
    throw new Error("regauge_production_bootstrap_approval_invalid");
  }
  for (const boundary of ["api_control_plane", "worker_action"] as const) {
    if (!assessTransformerGate({ tenantId, environment, boundary }, input.gateConfig).allowed) {
      throw new Error("regauge_production_bootstrap_gate_denied");
    }
  }
  const bootstrap: RegaugeProductionBootstrapInput = {
    tenantId,
    campaignId,
    environment,
    repository: {
      owner,
      name,
      remoteRepositoryId,
      defaultBranch,
      selectedBranch,
      expectedRevision,
      installationId,
      accountId,
      accountLogin: repositoryPart(input.repository.accountLogin, "regauge_production_bootstrap_account_invalid"),
    },
    plannerActorId,
    reviewer: {
      issuer,
      subject,
      displayName: text(input.reviewer.displayName, "regauge_production_bootstrap_reviewer_invalid", 200),
      email: input.reviewer.email === null
        ? null
        : text(input.reviewer.email, "regauge_production_bootstrap_reviewer_invalid", 320),
    },
    objective: {
      id: identifier(input.objective?.id, "regauge_production_bootstrap_objective_invalid"),
      statement: text(input.objective?.statement, "regauge_production_bootstrap_objective_invalid", 2_000),
      sourceSystem: text(input.objective?.sourceSystem, "regauge_production_bootstrap_objective_invalid", 200),
      targetSystem: text(input.objective?.targetSystem, "regauge_production_bootstrap_objective_invalid", 200),
    },
    gateConfig: input.gateConfig,
    productionApprovalRef,
    evidenceRefs,
  };
  const { gateConfig, ...authority } = bootstrap;
  const requestDigest = digest({ ...authority, gateConfigDigest: digest(gateConfig) });
  return Object.freeze({ bootstrap, reviewerActorId, requestDigest });
}

function validateControl(
  control: RegaugeProductionControl,
  plan: ReturnType<typeof normalize>,
  repository: RegaugeProductionRepositoryAuthority,
): void {
  const input = plan.bootstrap;
  const checks = [
    ["campaign", control.campaignId === input.campaignId],
    ["repository", control.repositoryId === repository.repositoryId],
    ["snapshot", control.snapshotId === repository.snapshotId],
    ["revision", control.revision === repository.revision],
    ["snapshot_digest", control.snapshotDigest === repository.snapshotDigest],
    ["planner", control.plannerActorId === input.plannerActorId],
    ["reviewer", control.reviewerActorIds.length === 1 && control.reviewerActorIds[0] === plan.reviewerActorId],
    ["source", control.sourceSystem === input.objective.sourceSystem],
    ["target", control.targetSystem === input.objective.targetSystem],
    ["objective", control.objectiveStatement === input.objective.statement],
    ["blueprint_digest", DIGEST.test(control.blueprintDigest)],
  ] as const;
  const failed = checks.find(([, valid]) => !valid);
  if (failed) throw new Error(`regauge_production_bootstrap_control_drift:${failed[0]}`);
}

function validateExecution(
  execution: RegaugeProductionExecution,
  control: RegaugeProductionControl,
): void {
  if (
    execution.campaignId !== control.campaignId ||
    execution.repositoryId !== control.repositoryId ||
    execution.snapshotId !== control.snapshotId ||
    execution.revision !== control.revision ||
    execution.snapshotDigest !== control.snapshotDigest ||
    execution.blueprintId !== control.blueprintId ||
    execution.blueprintDigest !== control.blueprintDigest
  ) {
    throw new Error("regauge_production_bootstrap_execution_drift");
  }
}

export async function bootstrapRegaugeProductionCampaign(
  rawInput: RegaugeProductionBootstrapInput,
  runtime: RegaugeProductionBootstrapRuntime,
): Promise<RegaugeProductionBootstrapReceipt> {
  const plan = normalize(structuredClone(rawInput));
  const existingReceipt = await runtime.readReceipt(plan.bootstrap.tenantId, plan.bootstrap.campaignId);
  if (existingReceipt) {
    if (existingReceipt.requestDigest !== plan.requestDigest) {
      throw new Error("regauge_production_bootstrap_idempotency_conflict");
    }
    const control = await runtime.readControl(plan.bootstrap.tenantId, plan.bootstrap.campaignId);
    if (!control) throw new Error("regauge_production_bootstrap_control_drift");
    validateControl(control, plan, {
      repositoryId: existingReceipt.repositoryId,
      snapshotId: existingReceipt.snapshotId,
      revision: existingReceipt.revision,
      snapshotDigest: existingReceipt.snapshotDigest,
    });
    if (control.blueprintId !== existingReceipt.blueprintId ||
        control.blueprintDigest !== existingReceipt.blueprintDigest) {
      throw new Error("regauge_production_bootstrap_control_drift:receipt");
    }
    const execution = await runtime.readExecution(plan.bootstrap.tenantId, plan.bootstrap.campaignId);
    if (!execution) throw new Error("regauge_production_bootstrap_execution_drift");
    validateExecution(execution, control);
    return Object.freeze(structuredClone(existingReceipt));
  }

  const repository = await runtime.prepareRepository(plan);
  if (
    repository.revision !== plan.bootstrap.repository.expectedRevision ||
    !REVISION.test(repository.revision) || !DIGEST.test(repository.snapshotDigest)
  ) {
    throw new Error("regauge_production_bootstrap_repository_drift");
  }
  let control = await runtime.readControl(plan.bootstrap.tenantId, plan.bootstrap.campaignId);
  if (!control) {
    control = await runtime.plan({
      tenantId: plan.bootstrap.tenantId,
      campaignId: plan.bootstrap.campaignId,
      environment: plan.bootstrap.environment,
      repositoryId: repository.repositoryId,
      snapshotId: repository.snapshotId,
      revision: repository.revision,
      snapshotDigest: repository.snapshotDigest,
      plannerActorId: plan.bootstrap.plannerActorId,
      reviewerActorId: plan.reviewerActorId,
      objective: plan.bootstrap.objective,
      evidenceRefs: plan.bootstrap.evidenceRefs,
      requestDigest: plan.requestDigest,
    });
  }
  validateControl(control, plan, repository);
  if (control.campaignState === "draft" && control.blueprintState === "draft") {
    control = await runtime.review({
      tenantId: plan.bootstrap.tenantId,
      campaignId: plan.bootstrap.campaignId,
      reviewerActorId: plan.reviewerActorId,
      evidenceRefs: plan.bootstrap.evidenceRefs,
      requestDigest: plan.requestDigest,
      control,
    });
    validateControl(control, plan, repository);
  }
  if (control.campaignState !== "ready" || control.blueprintState !== "reviewed") {
    throw new Error("regauge_production_bootstrap_review_required");
  }
  let execution = await runtime.readExecution(plan.bootstrap.tenantId, plan.bootstrap.campaignId);
  if (!execution) {
    execution = await runtime.launch({
      tenantId: plan.bootstrap.tenantId,
      campaignId: plan.bootstrap.campaignId,
      reviewerActorId: plan.reviewerActorId,
      evidenceRefs: plan.bootstrap.evidenceRefs,
      requestDigest: plan.requestDigest,
      control,
    });
  }
  validateExecution(execution, control);
  return runtime.recordReceipt({
    schemaVersion: "2026-08-14.v1",
    requestDigest: plan.requestDigest,
    tenantId: plan.bootstrap.tenantId,
    campaignId: plan.bootstrap.campaignId,
    repositoryId: repository.repositoryId,
    snapshotId: repository.snapshotId,
    revision: repository.revision,
    snapshotDigest: repository.snapshotDigest,
    blueprintId: control.blueprintId,
    blueprintDigest: control.blueprintDigest,
    state: execution.state,
  });
}
