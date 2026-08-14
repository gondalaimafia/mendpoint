import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT = /^warden-ci-evidence-([a-f0-9]{64})$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const MAX_BYTES = 128 * 1024;

function scope(value: string): string {
  if (!SCOPE.test(value) || value === "." || value === "..") throw new Error("warden_ci_evidence_scope_invalid");
  return value;
}

export function createWardenCiEvidenceStore(rootInput: string) {
  if (!rootInput.trim() || !isAbsolute(rootInput)) throw new Error("warden_ci_evidence_root_invalid");
  const root = resolve(rootInput);
  return Object.freeze({
    async publish(tenantIdInput: string, bytesInput: Uint8Array) {
      const tenantId = scope(tenantIdInput);
      const bytes = Buffer.from(bytesInput);
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) throw new Error("warden_ci_evidence_size_invalid");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const artifactId = `warden-ci-evidence-${hash}`;
      const directory = join(root, tenantId, "ci-observations");
      const path = join(directory, `${hash}.json`);
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(path);
        if (!existing.equals(bytes)) throw new Error("warden_ci_evidence_collision");
      }
      return Object.freeze({ artifactId, digest: `sha256:${hash}` });
    },
    async read(tenantIdInput: string, artifactId: string, expectedDigest: string): Promise<Uint8Array> {
      const tenantId = scope(tenantIdInput);
      const artifact = ARTIFACT.exec(artifactId);
      const digest = DIGEST.exec(expectedDigest);
      if (!artifact || !digest || artifact[1] !== digest[1]) throw new Error("warden_ci_evidence_identity_invalid");
      let bytes: Buffer;
      try { bytes = await readFile(join(root, tenantId, "ci-observations", `${artifact[1]}.json`)); }
      catch { throw new Error("warden_ci_evidence_missing"); }
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES ||
          createHash("sha256").update(bytes).digest("hex") !== artifact[1]) {
        throw new Error("warden_ci_evidence_digest_mismatch");
      }
      return new Uint8Array(bytes);
    },
  });
}
