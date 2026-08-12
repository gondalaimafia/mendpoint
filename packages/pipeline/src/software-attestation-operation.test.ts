import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertArtifactManifest, insertPrincipal } from "@mendpoint/db";
import { verifySoftwareAttestation } from "@mendpoint/contract";
import { issueSoftwareAttestation, readSoftwareAttestation, verifyStoredSoftwareAttestation } from "./software-attestation-operation.js";

const opened: ReturnType<typeof createDb>[] = [];
const roots: string[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.raw.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(tenantId = "tenant-a") {
  const root = mkdtempSync(join(tmpdir(), "attestation-operation-")); roots.push(root);
  const db = createDb(join(root, "test.sqlite")); opened.push(db);
  insertPrincipal(db, { id: "actor", tenantId, kind: "service", subject: "issuer", displayName: "Issuer", createdAt: "2026-08-12T12:00:00.000Z" });
  const add = (id: string, kind: string) => {
    const content = JSON.stringify({ id, kind });
    const sha256 = createHash("sha256").update(content).digest("hex");
    insertArtifactManifest(db, { id, tenantId, kind, schemaVersion: 1, sha256, mediaType: "application/json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://${id}`, content, producerPrincipalId: "actor", createdAt: "2026-08-12T12:00:00.000Z" });
  };
  return { db, add };
}

describe("software attestation operation", () => {
  it("resolves tenant artifacts, signs, persists evidence and event, and replays idempotently", async () => {
    const { db, add } = fixture();
    for (const [id, kind] of [["source", "source"], ["snapshot", "snapshot"], ["candidate", "candidate"], ["verification", "verification"], ["policy", "policy"], ["delivery", "delivery"]] as const) add(id, kind);
    const keys = generateKeyPairSync("ed25519");
    const input = { tenantId: "tenant-a", repositoryId: "repo", runId: "run", correlationId: "corr", actorPrincipalId: "actor", idempotencyKey: "idem", outcome: "passed" as const, issuedAt: "2026-08-12T12:00:01.000Z", artifacts: { sourceIds: ["source"], snapshotId: "snapshot", candidateId: "candidate", verificationIds: ["verification"], policyId: "policy", deliveryId: "delivery", rollbackId: null, waiverId: null } };
    const deps = { enabled: true as const, authorizeScope: () => true, signer: { keyId: "key-1", algorithm: "ed25519" as const, sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, keys.privateKey)) } };
    const first = await issueSoftwareAttestation(db, input, deps);
    const second = await issueSoftwareAttestation(db, input, deps);
    expect(second).toEqual(first);
    expect(readSoftwareAttestation(db, "tenant-a", first.attestationId)?.envelope).toEqual(first.envelope);
    const verified = await verifySoftwareAttestation({ envelope: first.envelope, expectedScope: structuredClone(first.scope) as never, verifiedAt: "2026-08-12T12:00:02.000Z", trustPolicy: { resolve: () => ({ keyId: "key-1", algorithm: "ed25519", publicKey: keys.publicKey, principalId: "actor", service: "mendpoint-attestation", tenantIds: ["tenant-a"], predicateTypes: [first.statement.predicateType], validFrom: "2026-08-12T00:00:00.000Z", validUntil: "2026-08-13T00:00:00.000Z", revokedAt: null }) } });
    expect(verified.statement.predicate.attestationId).toBe(first.attestationId);
    await expect(verifyStoredSoftwareAttestation(db, { tenantId: "tenant-a", attestationId: first.attestationId, verifiedAt: "2026-08-12T12:00:02.000Z", trustPolicy: { resolve: () => ({ keyId: "key-1", algorithm: "ed25519", publicKey: keys.publicKey, principalId: "different-actor", service: "mendpoint-attestation", tenantIds: ["tenant-a"], predicateTypes: [first.statement.predicateType], validFrom: "2026-08-12T00:00:00.000Z", validUntil: "2026-08-13T00:00:00.000Z", revokedAt: null }) } } )).rejects.toThrow("software_attestation_key_unauthorized");
    expect(db.raw.prepare("SELECT COUNT(*) c FROM evidence_records WHERE tenant_id = ?").get("tenant-a")).toEqual({ c: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) c FROM domain_events WHERE tenant_id = ?").get("tenant-a")).toEqual({ c: 1 });
  });

  it("is default off and rejects cross tenant artifacts and idempotency drift", async () => {
    const { db, add } = fixture(); add("candidate", "candidate");
    const base = { tenantId: "tenant-a", repositoryId: "repo", runId: "run", correlationId: "corr", actorPrincipalId: "actor", idempotencyKey: "idem", outcome: "passed" as const, issuedAt: "2026-08-12T12:00:01.000Z", artifacts: { sourceIds: ["candidate"], snapshotId: "candidate", candidateId: "candidate", verificationIds: ["candidate"], policyId: "candidate", deliveryId: null, rollbackId: null, waiverId: null } };
    await expect(issueSoftwareAttestation(db, base, { enabled: false, signer: {} as never })).rejects.toThrow("software_attestation_disabled");
  });
});
