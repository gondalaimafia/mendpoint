import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUSTOMER_QUALIFICATION_BUNDLE_SCHEMA,
  loadCustomerQualificationAuthority,
} from "./customer-qualification-authority.js";
import {
  CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA,
  CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
} from "./customer-readiness.js";

const REVISION = "a".repeat(40);
const tempRoots: string[] = [];

function digest(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mendpoint-qualification-"));
  tempRoots.push(root);
  const files = {
    requirementRegister: { path: "requirements.json", bytes: Buffer.from("{\"requirements\":[]}\n") },
    publicClaimsRegistry: { path: "claims.json", bytes: Buffer.from("{\"claims\":[]}\n") },
    evidenceManifest: { path: "evidence.json", bytes: Buffer.from("{\"evidence\":[]}\n") },
  };
  await Promise.all(Object.values(files).map((file) => writeFile(join(root, file.path), file.bytes)));
  const bundle = {
    schemaVersion: CUSTOMER_QUALIFICATION_BUNDLE_SCHEMA,
    attestation: {
      schemaVersion: CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA,
      qualifiedRevision: REVISION,
      requirementRegisterDigest: digest(files.requirementRegister.bytes),
      publicClaimsRegistryDigest: digest(files.publicClaimsRegistry.bytes),
      evidenceManifestDigest: digest(files.evidenceManifest.bytes),
      qualification: {
        outcome: "qualified",
        requirementCount: CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
        qualifiedRequirementCount: CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
      },
    },
    artifacts: {
      requirementRegister: { path: files.requirementRegister.path, sha256: digest(files.requirementRegister.bytes) },
      publicClaimsRegistry: { path: files.publicClaimsRegistry.path, sha256: digest(files.publicClaimsRegistry.bytes) },
      evidenceManifest: { path: files.evidenceManifest.path, sha256: digest(files.evidenceManifest.bytes) },
    },
    revokedEvidenceIds: [] as string[],
  };
  const writeBundle = async (value: unknown = bundle, path = "qualification.json") => {
    await writeFile(join(root, path), `${JSON.stringify(value)}\n`, "utf8");
  };
  await writeBundle();
  return { root, files, bundle, writeBundle };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("protected customer qualification authority", () => {
  it("loads only the exact revision and raw-byte-bound authority", async () => {
    const { root, bundle } = await fixture();
    const result = await loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    });

    expect(result).toEqual({
      status: "loaded",
      authority: {
        qualificationAttestation: bundle.attestation,
        trustRoots: {
          requirementRegisterDigest: bundle.attestation.requirementRegisterDigest,
          publicClaimsRegistryDigest: bundle.attestation.publicClaimsRegistryDigest,
          evidenceManifestDigest: bundle.attestation.evidenceManifestDigest,
        },
        revokedEvidenceIds: [],
        releaseRevision: REVISION,
      },
    });
  });

  it("rejects artifact byte drift and keeps the result non-authoritative", async () => {
    const { root, files } = await fixture();
    await writeFile(join(root, files.evidenceManifest.path), "{\"evidence\":[]}\r\n", "utf8");
    const result = await loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    });

    expect(result).toMatchObject({ status: "indeterminate", reason: "artifact_digest_mismatch" });
    expect(result.authority).toEqual({ releaseRevision: REVISION });
  });

  it("rejects deleted artifacts instead of treating absence as empty evidence", async () => {
    const { root, files } = await fixture();
    await rm(join(root, files.publicClaimsRegistry.path));
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "artifact_missing" });
  });

  it("rejects unknown, missing, and malformed schema fields", async () => {
    const { root, bundle, writeBundle } = await fixture();
    await writeBundle({ ...bundle, unexpected: true });
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "bundle_schema_invalid" });

    const { revokedEvidenceIds: _removed, ...missingRevocation } = bundle;
    await writeBundle(missingRevocation);
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "bundle_schema_invalid" });

    await writeFile(join(root, "qualification.json"), "{not-json", "utf8");
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "bundle_invalid" });
  });

  it("rejects stale revisions and attestation-to-artifact digest substitution", async () => {
    const { root, bundle, writeBundle } = await fixture();
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: "b".repeat(40),
    })).resolves.toMatchObject({ status: "indeterminate", reason: "release_revision_mismatch" });

    await writeBundle({
      ...bundle,
      attestation: { ...bundle.attestation, evidenceManifestDigest: digest("different") },
    });
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "attestation_digest_mismatch" });
  });

  it("rejects path traversal and absolute artifact paths before reading", async () => {
    const { root, bundle, writeBundle } = await fixture();
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "../qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "bundle_path_invalid" });

    await writeBundle({
      ...bundle,
      artifacts: {
        ...bundle.artifacts,
        evidenceManifest: { ...bundle.artifacts.evidenceManifest, path: join(root, "evidence.json") },
      },
    });
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "bundle_schema_invalid" });
  });

  it("rejects incomplete or ambiguous revocation state", async () => {
    const { root, bundle, writeBundle } = await fixture();
    for (const revokedEvidenceIds of [[""], [" revoked"], ["revoked", "revoked"]]) {
      await writeBundle({ ...bundle, revokedEvidenceIds });
      const result = await loadCustomerQualificationAuthority({
        authorityRoot: root,
        bundlePath: "qualification.json",
        releaseRevision: REVISION,
      });
      expect(result).toMatchObject({ status: "indeterminate", reason: "bundle_schema_invalid" });
      expect(result.authority).not.toHaveProperty("revokedEvidenceIds");
    }
  });

  it("rejects artifact symlinks without reading their target when supported", async () => {
    const { root, bundle, writeBundle } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "mendpoint-qualification-victim-"));
    tempRoots.push(outside);
    await writeFile(join(outside, "victim.json"), "outside", "utf8");
    await rm(join(root, "evidence.json"));
    try {
      await symlink(join(outside, "victim.json"), join(root, "evidence.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await writeBundle({
      ...bundle,
      artifacts: {
        ...bundle.artifacts,
        evidenceManifest: { path: "evidence.json", sha256: digest("outside") },
      },
      attestation: { ...bundle.attestation, evidenceManifestDigest: digest("outside") },
    });
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "artifact_reparse_point" });
  });

  it("rejects a substituted bundle symlink and a substituted authority root when supported", async () => {
    const { root, bundle } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "mendpoint-qualification-bundle-victim-"));
    tempRoots.push(outside);
    await writeFile(join(outside, "qualification.json"), `${JSON.stringify(bundle)}\n`, "utf8");
    await rm(join(root, "qualification.json"));
    try {
      await symlink(join(outside, "qualification.json"), join(root, "qualification.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "bundle_reparse_point" });

    const rootLink = join(outside, "authority-root");
    await symlink(root, rootLink, process.platform === "win32" ? "junction" : "dir");
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: rootLink,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "authority_root_reparse_point" });
  });

  it("rejects Windows junction ancestors and does not consume an outside victim", async () => {
    if (process.platform !== "win32") return;
    const { root, bundle, writeBundle } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "mendpoint-qualification-junction-victim-"));
    tempRoots.push(outside);
    await writeFile(join(outside, "victim.json"), "outside", "utf8");
    await mkdir(join(root, "links"));
    await symlink(outside, join(root, "links", "outside"), "junction");
    await writeBundle({
      ...bundle,
      artifacts: {
        ...bundle.artifacts,
        evidenceManifest: { path: "links/outside/victim.json", sha256: digest("outside") },
      },
      attestation: { ...bundle.attestation, evidenceManifestDigest: digest("outside") },
    });
    await expect(loadCustomerQualificationAuthority({
      authorityRoot: root,
      bundlePath: "qualification.json",
      releaseRevision: REVISION,
    })).resolves.toMatchObject({ status: "indeterminate", reason: "artifact_reparse_point" });
  });
});
