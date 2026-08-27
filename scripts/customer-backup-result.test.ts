import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const verifier = resolve(root, "scripts/verify-customer-backup-result.sh");
const prefix = "MENDPOINT_CUSTOMER_BACKUP_RESULT ";
const roots: string[] = [];
const jqAvailable = spawnSync("bash", ["-lc", "command -v jq"], { encoding: "utf8" }).status === 0;
const jqIt = jqAvailable ? it : it.skip;

function resultRecord(overrides: Record<string, unknown> = {}): string {
  return `${prefix}${JSON.stringify({
    schemaVersion: 1,
    kind: "customer_backup_result",
    result: "success",
    releaseRevision: "d".repeat(40),
    backupId: "backup-1",
    manifestAuthentication: "a".repeat(64),
    publication: {
      kind: "s3",
      backupId: "backup-1",
      bucket: "customer-backups",
      prefix: "backups/backup-1",
      endpointOrigin: "https://objects.example.test",
      commitDigest: "b".repeat(64),
      manifestSha256: "c".repeat(64),
    },
    ...overrides,
  })}`;
}

function verifyLog(lines: readonly string[], expectedReleaseRevision = "d".repeat(40)) {
  const temporary = mkdtempSync(join(tmpdir(), "mendpoint-backup-result-"));
  roots.push(temporary);
  const log = join(temporary, "backup.log");
  writeFileSync(log, `${lines.join("\n")}\n`, "utf8");
  return spawnSync("bash", [verifier, log, expectedReleaseRevision], { encoding: "utf8" });
}

/**
 * Exercise the shell data flow on hosts without jq. The shim models jq's
 * relevant output shape: a bare predicate emits `true`, while a validating
 * filter that explicitly returns its input emits the original JSON object.
 * Real jq still runs in the jqIt cases on Ubuntu.
 */
function verifyObjectRetention(lines: readonly string[], expectedReleaseRevision = "d".repeat(40)) {
  const temporary = mkdtempSync(join(tmpdir(), "mendpoint-backup-result-shape-"));
  roots.push(temporary);
  const log = join(temporary, "backup.log");
  const jq = join(temporary, "jq");
  writeFileSync(log, `${lines.join("\n")}\n`, "utf8");
  writeFileSync(jq, `#!/usr/bin/env node
const fs = require("node:fs");
const filter = process.argv.at(-1) ?? "";
const input = fs.readFileSync(0, "utf8").trim();
let value;
try { value = JSON.parse(input); } catch { process.exit(4); }
if (filter.trim() === ".releaseRevision") {
  if (!value || typeof value !== "object" || typeof value.releaseRevision !== "string") process.exit(5);
  process.stdout.write(value.releaseRevision + "\\n");
} else if (/then\\s+\\.\\s+else/s.test(filter)) {
  process.stdout.write(JSON.stringify(value) + "\\n");
} else {
  process.stdout.write("true\\n");
}
`, "utf8");
  chmodSync(jq, 0o755);
  return spawnSync("bash", [verifier, log, expectedReleaseRevision], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${temporary}${delimiter}${process.env.PATH ?? ""}` },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("customer backup terminal result", () => {
  it("rejects unrelated log substrings that resemble backup evidence", () => {
    const result = verifyLog([
      'noise {"backupId":"forged"}',
      'noise {"manifestAuthentication":"aaaaaaaa"}',
      'noise {"publication":{"kind":"s3"}}',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer_backup_result_record_count_invalid");
  });

  jqIt("rejects a malformed uniquely prefixed terminal record", () => {
    const result = verifyLog([`${prefix}{"schemaVersion":1`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer_backup_result_invalid");
  });

  it("rejects multiple otherwise valid terminal records", () => {
    const record = resultRecord();
    const result = verifyLog([record, record]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer_backup_result_record_count_invalid");
  });

  jqIt("rejects an otherwise valid result from a different live release", () => {
    const result = verifyLog([resultRecord({ releaseRevision: "e".repeat(40) })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("customer_backup_result_release_revision_mismatch");
  });

  it("accepts and exactly binds a canonical 64 character release", () => {
    const release = "e".repeat(64);
    const record = resultRecord({ releaseRevision: release });
    const accepted = verifyObjectRetention([record], release);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ releaseRevision: release });

    const stale = verifyObjectRetention([record], "f".repeat(64));
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("customer_backup_result_release_revision_mismatch");
  });

  it("retains the validated JSON object for exact release binding", () => {
    const record = resultRecord();
    const accepted = verifyObjectRetention([record]);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      releaseRevision: "d".repeat(40),
      backupId: "backup-1",
      publication: { kind: "s3", backupId: "backup-1" },
    });

    const stale = verifyObjectRetention([record], "e".repeat(40));
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("customer_backup_result_release_revision_mismatch");
  });

  jqIt("accepts exactly one complete successful publication record", () => {
    const record = resultRecord();
    const result = verifyLog(["progress", record]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: "customer_backup_result",
      result: "success",
      releaseRevision: "d".repeat(40),
      backupId: "backup-1",
      publication: { kind: "s3", backupId: "backup-1" },
    });
  });
});
