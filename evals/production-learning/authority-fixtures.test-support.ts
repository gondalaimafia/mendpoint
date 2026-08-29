import type { SignedAuthorityEnvelope } from "./authority.js";
import type { EvaluationArm, EvaluationGradeAuthorityPayload, EvaluationMetrics } from "./evaluation.js";
import type { ExternalProviderTransmissionAuthorityPayload } from "./learning.js";
import type { CaseExecutionEvidenceAuthorityPayload } from "./matrix.js";
import type { ProductionLearningAuthorityPayload } from "./preflight.js";

export const SHA = "a".repeat(64);
export const PREFLIGHT_REVISION = "b".repeat(40);
export const EVALUATION_PRODUCTION_REVISION = "f".repeat(40);
export const EVALUATION_REPOSITORY_COMMIT = "e".repeat(40);
export const PREFLIGHT_FIXTURE_DIGEST = "8262b5bf6a876cb940f2453bb7e70fcc74e017a11dc691cdd6ee3d07defddd48";

export function installTestAuthorityTrustRoots(): void {
  process.env.MENDPOINT_PRODUCTION_LEARNING_PUBLIC_KEY_SPKI_BASE64 = "MCowBQYDK2VwAyEAtHr/nbkT8McGDbavvjSp7oWLpanL07bwXf5JHpzxkgY=";
  process.env.MENDPOINT_PRODUCTION_LEARNING_TRUSTED_KEY_SHA256 = "a5828dad8415ec6c7d70eba15ecf399ca21941add6f673bc1588656ecea82c60";
  process.env.MENDPOINT_PRODUCTION_LEARNING_MINIMUM_ISSUED_AT = "2026-01-01T00:00:00.000Z";
  process.env.MENDPOINT_EXTERNAL_PROVIDER_PUBLIC_KEY_SPKI_BASE64 = "MCowBQYDK2VwAyEAWIQyPsEbTcLdHHEChm8pMA/Dcw33h0ppwLjassvDjcE=";
  process.env.MENDPOINT_EXTERNAL_PROVIDER_TRUSTED_KEY_SHA256 = "71dc3ef2dba5fb6d07f47402efcea7e9b1e407ae2caf733828cf349ce1f97eee";
  process.env.MENDPOINT_EXTERNAL_PROVIDER_MINIMUM_ISSUED_AT = "2026-01-01T00:00:00.000Z";
  process.env.MENDPOINT_EVALUATION_GRADING_PUBLIC_KEY_SPKI_BASE64 = "MCowBQYDK2VwAyEAA/C8ZPCO4+I95alR80dPxvLZp8hzj89mclxxA4GVphc=";
  process.env.MENDPOINT_EVALUATION_GRADING_TRUSTED_KEY_SHA256 = "b3efb695aa915685e4e1c2b285b9df752f4df6c57d61716e704d2c552974062a";
  process.env.MENDPOINT_EVALUATION_GRADING_MINIMUM_ISSUED_AT = "2026-01-01T00:00:00.000Z";
  process.env.MENDPOINT_CASE_EXECUTION_EVIDENCE_PUBLIC_KEY_SPKI_BASE64 = "MCowBQYDK2VwAyEAZcGysaBycmIFdZqaVqe9zXXMMsRxAw8TOF8OxABd9eE=";
  process.env.MENDPOINT_CASE_EXECUTION_EVIDENCE_TRUSTED_KEY_SHA256 = "7d17f19091870c423d360b54563d7c943a05cdda8f977b9ba8e84f76042d4c82";
  process.env.MENDPOINT_CASE_EXECUTION_EVIDENCE_MINIMUM_ISSUED_AT = "2026-01-01T00:00:00.000Z";
}

const VALIDITY = {
  schemaVersion: "mendpoint.signed-authority.v1" as const,
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};

function preflightPayload(
  productionRevision = PREFLIGHT_REVISION,
  authorizationRef = "authorization://benchmark-tenant-a/run-1",
): ProductionLearningAuthorityPayload {
  return {
    caseId: "FET-E001", product: "fettler", productionRevision, tenantId: "benchmark-tenant-a",
    repositoryId: "repo-a", repositoryCommit: PREFLIGHT_REVISION, snapshotDigest: SHA,
    fixtureManifestDigest: PREFLIGHT_FIXTURE_DIGEST, graphVersion: "graph-v1", policyVersion: "policy-v1",
    modelProvider: "configured", modelId: "model-v1", routerVersion: "router-v1", recipeVersion: null,
    consentEvidenceRef: "consent://benchmark-tenant-a/evaluation/v1", authorizationRef,
    sandboxReceiptDigest: SHA, executionDigest: SHA,
  };
}

export const PREFLIGHT_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ProductionLearningAuthorityPayload> = {
  ...VALIDITY,
  issuer: "mendpoint-production-learning-control-plane",
  keyId: "production-learning-ed25519-v1",
  payload: preflightPayload(),
  signature: "w+vxZC2cTEv7c9r87IDboQk46Ejg9I8loHKgOtQLGa+bCy5yrGEVN0mq+A9QsZ7ZFJ2f/wPhHIk5dxov/PbvBw==",
};

export const PREFLIGHT_MISMATCH_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ProductionLearningAuthorityPayload> = {
  ...VALIDITY,
  issuer: "mendpoint-production-learning-control-plane",
  keyId: "production-learning-ed25519-v1",
  payload: preflightPayload("c".repeat(40), "authorization://benchmark-tenant-a/protected-run"),
  signature: "jzuJ2OiLno5tH0oeXYlMkHxzFHmYX/gnTAI6SH1edXve2nf0EGTK67D5x7eVMdNoC3wmnaCeAWCWRqUNbZ+nCQ==",
};

export const PREFLIGHT_EXPIRED_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ProductionLearningAuthorityPayload> = {
  ...PREFLIGHT_AUTHORITY_ENVELOPE,
  expiresAt: "2026-02-01T00:00:00.000Z",
  signature: "vTyTfe2SP3PTa0PLnCM2EolmMRbQ4rVBs5K/p3NcElfUlv+0KzWdnWhceNV+XZnVhdljPbqbzG5w0E4J0dInCg==",
};

export const MATRIX_PRODUCTION_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ProductionLearningAuthorityPayload> = {
  ...VALIDITY,
  issuer: "mendpoint-production-learning-control-plane",
  keyId: "production-learning-ed25519-v1",
  payload: {
    caseId: "FET-C001", product: "fettler", productionRevision: PREFLIGHT_REVISION,
    tenantId: "benchmark-tenant-matrix", repositoryId: "repo-octokit-webhooks-js",
    repositoryCommit: "b47e4b0049f8353d4ad796a5d0af26c4e568d732", snapshotDigest: "9".repeat(64),
    fixtureManifestDigest: "1".repeat(64), graphVersion: "graph-v1", policyVersion: "policy-v1",
    modelProvider: "configured", modelId: "model-v1", routerVersion: "router-v1", recipeVersion: null,
    consentEvidenceRef: "consent://benchmark-tenant-matrix/evaluation/v1",
    authorizationRef: "authorization://benchmark-tenant-matrix/FET-C001/v1",
    sandboxReceiptDigest: "8".repeat(64), executionDigest: "2".repeat(64),
  },
  signature: "K2FTUnAnPxubCPvTtIo/fHRJYtHWj8a6lUangBRh6b/DXTRoit40LCLUKEM6HI0dLYMH4KY+5REPbhTH+qYpCw==",
};

export const MATRIX_EXECUTION_EVIDENCE_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<CaseExecutionEvidenceAuthorityPayload> = {
  ...VALIDITY,
  issuer: "mendpoint-case-execution-evidence-control-plane",
  keyId: "case-execution-evidence-ed25519-v1",
  payload: {
    schemaVersion: "mendpoint.case-execution-evidence-authority.v1", productionRevision: PREFLIGHT_REVISION,
    receiptId: "receipt-matrix-fet-c001", caseId: "FET-C001", product: "fettler",
    tenantId: "benchmark-tenant-matrix", repositoryId: "repo-octokit-webhooks-js",
    repositoryCommit: "b47e4b0049f8353d4ad796a5d0af26c4e568d732", snapshotDigest: "9".repeat(64),
    fixtureManifestDigest: "1".repeat(64), executionDigest: "2".repeat(64),
    fixtureManifestId: "fixture-fet-c001-manifest-v1", oracleIds: ["oracle-fet-c001-github-version-header"],
    productionReceiptAuthorityDigest: "8f2431a33ae34d5f3c6dba44590c6c9d4e84028ab6b2996d51bc4fe5bb309edf",
    requirementIds: ["ME-WAR-001"], oracleEvidenceIds: ["oracle-evidence-fet-c001-run-1"],
    productionEvidenceIds: ["production-evidence-fet-c001-run-1"], admissionState: "admitted", executionState: "completed",
  },
  signature: "XxTnEOZ7Lrel2g8sZoG0JAkFhpR/Zw1+g3dRsLOQDM99C3B4SA2p1xF8/DFBstIOsPwgBeQmmnglHQ8ywR0SBg==",
};

const PROVIDER_PAYLOAD: ExternalProviderTransmissionAuthorityPayload = {
  schemaVersion: "mendpoint.external-provider-transmission-authority.v1", productionRevision: PREFLIGHT_REVISION,
  tenantId: "benchmark-tenant-a", repositoryId: "repo-a", repositoryCommit: PREFLIGHT_REVISION,
  repositorySnapshotDigest: SHA, providerId: "provider-a", purpose: "case_execution",
  consentEvidenceRef: "consent://benchmark-tenant-a/governed-learning/v1", licenseEvidenceRef: "license://repo-a/v1",
  sharedTrainingAllowed: false, repositoryContentAllowed: false,
};

export const PROVIDER_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ExternalProviderTransmissionAuthorityPayload> = {
  ...VALIDITY,
  issuer: "mendpoint-external-provider-control-plane",
  keyId: "external-provider-ed25519-v1",
  payload: PROVIDER_PAYLOAD,
  signature: "NWpyqey4Dydm4jWQ08XaOMIoJaxmNDsfWg+1zQ9960fgBn3VaclMuO5m+Jzm9DtB+KGiJtXlasCkdbPKPXB/Dw==",
};

export const PROVIDER_MISMATCH_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ExternalProviderTransmissionAuthorityPayload> = {
  ...VALIDITY,
  issuer: "mendpoint-external-provider-control-plane",
  keyId: "external-provider-ed25519-v1",
  payload: { ...PROVIDER_PAYLOAD, repositorySnapshotDigest: "c".repeat(64) },
  signature: "x9FWBz0i9PfyJSxH7m0l89V+alIc3CWBsmHIfvBuit8wYy2LSU/bBBgSD5nRuhBBa0m23j95TRLyZPmcn5L6AQ==",
};

export const PROVIDER_EXPIRED_AUTHORITY_ENVELOPE: SignedAuthorityEnvelope<ExternalProviderTransmissionAuthorityPayload> = {
  ...PROVIDER_AUTHORITY_ENVELOPE,
  expiresAt: "2026-02-01T00:00:00.000Z",
  signature: "Feu/b2wr2m44N9ktOxNuMts/1nZqkjxyBzvlN0rnwgOtLd74hTz5e7LlGn1MfoEsTsh/88MF/Kjr1EQ7HlFbCw==",
};

export const EVALUATION_ARMS: readonly EvaluationArm[] = [
  "production_baseline", "deterministic_recipe", "configured_model_router", "advisory_verifier", "oracle",
];

const EXECUTION_DIGESTS: Record<EvaluationArm, string> = {
  production_baseline: "66b59ac7e8448eb6057bf37c819ee2eb5b1794b15ef7904b40cd7778db27370a",
  deterministic_recipe: "2c7b1437166bd2948adde2e95d12d46d6f65a62355f4c9f6bf3c04fd601b7b43",
  configured_model_router: "98f0db4b7e975e3fd244718ebf43f16def4b3fe066cfbcc42419ed71cdae62a1",
  advisory_verifier: "346e3a110f2a25253552a28ad97431b9bed4d109c30ff7eb652769357aea4d0f",
  oracle: "c0d2a56109fd7d374f9db393210c10d26020f8e4a95e73a8af53b4d3121505aa",
};
const PREDICTION_DIGESTS: Record<EvaluationArm, string> = {
  production_baseline: "176d23e55ffd0478e5fc92f7b592fcbc79833c60f90065b560a7ff898aedbb7c",
  deterministic_recipe: "09e4a61351bca40177ae79b9817757d1667d003e1d8bb6123341c3fc3e1ab599",
  configured_model_router: "383baa609949f2d8374cdc3e71a7a51d28d9feb8fe5f40922158b2a8f6bb8f02",
  advisory_verifier: "6173759a041a8818ebe611d70e7eb988f9613b1f26a52ec3167d551b05db3fb5",
  oracle: "b4d585fd17aeb01e201d0dcb7b1fd0ff55a7d753dbc3ac6d16ec91cc90209d8d",
};
const PRODUCTION_SIGNATURES: Record<EvaluationArm, string> = {
  production_baseline: "OzLHpbjtT5UrJwAQQTHnHgKieM2VmsOfIfbTpk1cD9JtONDIP5mqyMDqQqpb4o+UO2Wev8I6kyLkGv2xFnISBw==",
  deterministic_recipe: "x4LZE1vJTw1ghg5bstNYoSmWIJMzoMYvVyBp7E8wC8OulpTc6S12RiQJ+ENif2j1js3Y2gKR688bqGA3BidkCQ==",
  configured_model_router: "DrqRAiP0H6Fyek+84M8CaHL/N3d2Yn+WiGP2Oia/9CmL7LC24yt+eMF2PPxr8376XPW7k9BHRYCngT2fO+UKBw==",
  advisory_verifier: "+v2MYIme6bg0X42bpyUTXfJ2Wsx9p26Bo3oDPrOUZZoTuHBReWHT0IYUZsNTv0eZasTYzeeka4yd9DsRiSyTAA==",
  oracle: "FwiQ3R60s8msyZ178IdoRpuG1w0U36+C/vA6VqSd+kpvURHZIdPbfwzo15EWap1xqA83bdcpSpHe/TqGt3MnBw==",
};
const PRODUCTION_DIGESTS: Record<EvaluationArm, string> = {
  production_baseline: "4f2087f45f20a527c0e6fa1f71977f471da7c56f3574b0b9d5a2a0623b490fb8",
  deterministic_recipe: "0c0a84086d53baff453725c45a051f65e13348629d408d9d96108863fb45ba43",
  configured_model_router: "a775146434e647e50e0be292252f2c675cd8ae9dbe3714054aa6c2ee9750561b",
  advisory_verifier: "4f7bbea5d869d2812f78b79f60d23db5ad2636a150023bf7c7d55e92db1a0117",
  oracle: "0962730736e5c0112da8407acab83b0222e4865a836447118275e1a9e81db30e",
};
const GRADE_SIGNATURES: Record<EvaluationArm, string> = {
  production_baseline: "kSD091TAht59drG/4/2/wX9jK767AubUh5eRr4fwoS61/DPSqhx9yd5bEkYwcOYGh1EUd7OMOLvrnpUmqfMSCA==",
  deterministic_recipe: "NGEKTyxQWlKwIu6YJPqPdoO7hl3NRx/CJSyCmxpOaRwyQSsoqPi7Qlq/vyU7Cswz1REtUx7Qfa5Wa6A0BYetAQ==",
  configured_model_router: "y5f67aptbarO4rMuldcc1cHnB9n4FRSR3HkiDWVC2zniha4iHL2Ui2liGi851RvgLSbgHijrKuTUAQ/eCvj4CA==",
  advisory_verifier: "oiJfvBssf+FaHhWOMUAJkGop0DpmyUkSGkoquQnlNxPHIHT3Q97mtF1EmKh+/RXedE7zhNJvCYHvIki3QH6tBw==",
  oracle: "vMQZOmQYMA6XDy8mdrefaNTKMsYy/XV6DmgnRQ2vHYOzbYIRIaZqGHIPNgMId8cvYu8GCL+QE6kssh7Qbl0qCA==",
};
const METRICS_DIGESTS: Record<EvaluationArm, string> = {
  production_baseline: "d5c976110a48baf45d24c99c68d99fbf5ccb016c9c1446189a3ca95048314958",
  deterministic_recipe: "d5c976110a48baf45d24c99c68d99fbf5ccb016c9c1446189a3ca95048314958",
  configured_model_router: "d5c976110a48baf45d24c99c68d99fbf5ccb016c9c1446189a3ca95048314958",
  advisory_verifier: "d5c976110a48baf45d24c99c68d99fbf5ccb016c9c1446189a3ca95048314958",
  oracle: "952439865345b5ac3c0ce6a0b17efed6e24f8a50b6534a344e929404e06cb104",
};

export function evaluationMetrics(arm: EvaluationArm): EvaluationMetrics {
  return {
    success: arm === "oracle", correctAbstention: false, falseRepairOrMigration: false, falseNoImpact: false,
    deterministicVerificationPass: arm === "oracle", rollbackPass: true, tenantIsolationPass: true,
    replayIdempotencyPass: true, severeRegression: false, latencyMs: arm === "oracle" ? 10 : 100,
    costUsd: arm === "oracle" ? 0 : 0.1,
  };
}

export function evaluationProductionAuthorityEnvelope(
  arm: EvaluationArm,
): SignedAuthorityEnvelope<ProductionLearningAuthorityPayload> {
  return {
    ...VALIDITY,
    issuer: "mendpoint-production-learning-control-plane",
    keyId: "production-learning-ed25519-v1",
    payload: {
      caseId: "REG-E001", product: "regauge", productionRevision: EVALUATION_PRODUCTION_REVISION,
      tenantId: "benchmark-tenant-a", repositoryId: "repo-example", repositoryCommit: EVALUATION_REPOSITORY_COMMIT,
      snapshotDigest: SHA, fixtureManifestDigest: "1".repeat(64), graphVersion: "graph-v1", policyVersion: "policy-v1",
      modelProvider: "configured", modelId: `model-${arm}`, routerVersion: "router-v1",
      recipeVersion: arm === "deterministic_recipe" ? "recipe-v1" : null,
      consentEvidenceRef: "consent://benchmark-tenant-a/evaluation/v1", authorizationRef: "authorization://benchmark-tenant-a/REG-E001/v1",
      sandboxReceiptDigest: "8".repeat(64), executionDigest: EXECUTION_DIGESTS[arm],
    },
    signature: PRODUCTION_SIGNATURES[arm],
  };
}

export function evaluationGradeAuthorityEnvelope(
  arm: EvaluationArm,
): SignedAuthorityEnvelope<EvaluationGradeAuthorityPayload> {
  return {
    ...VALIDITY,
    issuer: "mendpoint-evaluation-grading-control-plane",
    keyId: "evaluation-grading-ed25519-v1",
    payload: {
      schemaVersion: "mendpoint.evaluation-grade-authority.v1", productionRevision: EVALUATION_PRODUCTION_REVISION,
      caseId: "REG-E001", arm, tenantId: "benchmark-tenant-a", repositoryProvenanceId: "repo-example",
      repositoryCommit: EVALUATION_REPOSITORY_COMMIT, snapshotDigest: SHA, fixtureManifestDigest: "1".repeat(64),
      executionDigest: EXECUTION_DIGESTS[arm], productionReceiptAuthorityDigest: PRODUCTION_DIGESTS[arm],
      predictionArtifactDigest: PREDICTION_DIGESTS[arm], predictionSealedAt: "2026-08-28T23:00:00.000Z",
      answerKeyOpenedAt: "2026-08-28T23:01:00.000Z", answerKeyAccessReceiptDigest: "d".repeat(64),
      gradedAt: "2026-08-28T23:02:00.000Z", metricsDigest: METRICS_DIGESTS[arm],
    },
    signature: GRADE_SIGNATURES[arm],
  };
}
