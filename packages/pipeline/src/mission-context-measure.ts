/**
 * Measurement harness for the Mission Context Compiler (run with tsx).
 * Reports: (1) the constant baseline prompt (no tenant context today), (2) a
 * representative compiled inherited-context size, and (3) the reduction the
 * bounded selection achieves against an unbounded dump of the same inputs.
 *
 * Not a test; a reproducible measurement. Numbers are copied into
 * docs/missions/CONTEXT_COMPILER.md and the PR body.
 */
import { wardenPlaybook } from "@mendpoint/agent";
import type { OrganizationMemoryRecord } from "@mendpoint/db";
import {
  compileAndRenderMissionContext,
  type MissionContextInput,
  type OrgMemoryInput,
} from "./mission-context-compiler.js";

function memory(scope: string, statement: string, memoryId: string): OrganizationMemoryRecord {
  return {
    recordId: `omv1:${memoryId}`,
    tenantId: "t1",
    memoryId,
    revision: 1,
    supersedesRecordId: null,
    transition: "activated",
    scope,
    category: "MIGRATION_PREFERENCE",
    statement,
    structuredValue: null,
    source: "explicit",
    sourceRefs: [],
    observationFingerprint: null,
    confidence: "high",
    status: "ACTIVE",
    appliesTo: [],
    trainingEligible: false,
    actorPrincipalId: null,
    reason: "measure",
    contentSha256: "0".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    lastConfirmedAt: "2026-01-01T00:00:00.000Z",
  } as OrganizationMemoryRecord;
}

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

// (1) Today's constant prompt carries no tenant/task context.
const baseline = wardenPlaybook();
console.log(`baseline wardenPlaybook bytes: ${bytes(baseline)}`);

// (2) A representative small envelope: a handful of applicable conventions.
const representativeMemories: OrgMemoryInput[] = [
  { subjectKey: "imports", record: memory("imports", "use the internal auth client, never direct OAuth calls", "om-1") },
  { subjectKey: "pr", record: memory("pr", "squash-merge only; no merge commits", "om-2") },
  { subjectKey: "copy", record: memory("copy", "no em dashes in user-facing strings", "om-3") },
];
const representative: MissionContextInput = {
  tenantId: "t1",
  mission: { missionId: "m1", product: "fettler", objective: "Migrate the payments SDK to v2", repositoryId: "r1", snapshotId: "s1", graphVersionId: null },
  task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Migrate the checkout call site" },
  hardPolicies: { consulted: false, reason: "store_not_available" },
  missionDecisions: { consulted: true, records: [{ tenantId: "t1", id: "d1", subjectKey: "pr", directive: "this migration must land atomically in one PR", decidedAt: "2026-01-01T00:00:00.000Z" }] },
  organizationMemory: { consulted: true, records: representativeMemories },
  userPreferences: { consulted: false, reason: "store_not_available" },
  graph: { consulted: false, reason: "graph_version_absent" },
  history: { consulted: true, records: [{ tenantId: "t1", trajectoryRef: "traj-9", outcome: "candidate_ready", summary: "prior attempt migrated 3 of 4 call sites" }] },
  verification: { consulted: true, records: [{ tenantId: "t1", id: "v1", statement: "integration suite green", verdict: "passed", state: "current_evidence", reason: null, boundSnapshotId: "s1" }] },
  exceptions: { consulted: true, records: [] },
};
const repCompiled = compileAndRenderMissionContext(representative);
console.log(`representative envelope injection bytes: ${repCompiled.injection.byteLength}`);
console.log(`representative context refs: ${repCompiled.refs.length}`);
console.log(`representative applied memory: ${repCompiled.envelope.relevantOrgMemory.status === "consulted" ? repCompiled.envelope.relevantOrgMemory.applied.length : "n/a"}, overridden: ${repCompiled.envelope.relevantOrgMemory.status === "consulted" ? repCompiled.envelope.relevantOrgMemory.overridden.length : "n/a"}`);

// (3) Bounded selection vs unbounded dump of the SAME oversized inputs.
const bigMemories: OrgMemoryInput[] = Array.from({ length: 500 }, (_, i) => ({ subjectKey: `s-${i}`, record: memory(`s-${i}`, `convention ${i}: keep handlers under 40 lines and colocate tests`, `om-big-${i}`) }));
const bigHistory = Array.from({ length: 500 }, (_, i) => ({ tenantId: "t1", trajectoryRef: `t-${i}`, outcome: "failed", summary: `attempt ${i} touched src/checkout and failed the contract test` }));
const oversized: MissionContextInput = { ...representative, organizationMemory: { consulted: true, records: bigMemories }, history: { consulted: true, records: bigHistory } };
const unboundedDumpBytes = bytes(JSON.stringify({ memories: bigMemories.map((m) => m.record.statement), history: bigHistory }));
const boundedCompiled = compileAndRenderMissionContext(oversized);
const reduction = (1 - boundedCompiled.injection.byteLength / unboundedDumpBytes) * 100;
console.log(`oversized unbounded dump bytes: ${unboundedDumpBytes}`);
console.log(`oversized compiled (bounded) bytes: ${boundedCompiled.injection.byteLength}`);
console.log(`repeated-information reduction vs unbounded dump: ${reduction.toFixed(1)}%`);
console.log(`bounded ceiling honoured (<= 32768): ${boundedCompiled.injection.byteLength <= 32_768}`);
console.log(`prompt truncated: ${boundedCompiled.envelope.bounds.promptTruncated}, items capped: ${boundedCompiled.envelope.bounds.sectionItemsCapped}`);
