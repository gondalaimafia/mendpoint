import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sandboxEgressAuthorityFromEnv,
  verifySandboxEgressAuthority,
} from "@mendpoint/platform";

/**
 * Install a signed sandbox egress receipt onto the persistent volume, IN the
 * running customer machine, over `flyctl ssh console --command`.
 *
 * flyctl word-splits the --command and execs it without a shell, so the base64
 * attestation (which contains no spaces or shell metacharacters) arrives as the
 * single trailing argument -- process.argv[2] once Node has consumed the script
 * path. This script NEVER trusts that argument: it verifies it against THIS
 * machine's own trust configuration (public key, key id, policy digest, expected
 * app and image, schema floor, current time) BEFORE writing, then writes
 * atomically so a reader never sees a partial file. Delivering the receipt as a
 * file the app re-reads lets the 6-hourly renewal refresh it without a machine
 * update, secrets set, or restart -- the operations that repeatedly stopped this
 * single-machine production app.
 */

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

export function installSandboxEgressAttestation(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const attestation = argv[2]?.trim();
  if (!attestation) fail("sandbox_egress_attestation_install_argument_missing");

  const path = env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PATH?.trim();
  if (!path) fail("sandbox_egress_attestation_install_path_unset");
  const expectedApp = env.MENDPOINT_SANDBOX_FLY_APP?.trim();
  const expectedImage = env.MENDPOINT_SANDBOX_FLY_IMAGE?.trim();
  if (!expectedApp || !expectedImage) fail("sandbox_egress_attestation_install_scope_unset");

  // >>> pre-write-verification (load-bearing; the install-script test proves a
  // tampered or mis-scoped receipt is refused here, before anything is written).
  let testedAt: string;
  let expiresAt: string;
  try {
    const { payload } = verifySandboxEgressAuthority({
      ...sandboxEgressAuthorityFromEnv(env),
      // Verify the argument directly, never a file: this is the source of truth
      // the file will hold, so it must stand on its own against this machine.
      attestationBase64: attestation,
      attestationPath: undefined,
      expectedApp,
      expectedImage,
      observedAt: new Date().toISOString(),
    });
    testedAt = payload.testedAt;
    expiresAt = payload.expiresAt;
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "sandbox_egress_attestation_scope_mismatch") {
      // The receipt's scope (app/image/policy) does not match this machine. The
      // dominant cause is an image change: the sandbox image was rotated, so the
      // running app must be redeployed to the new image before its receipt can be
      // installed. A file delivery cannot substitute for a deploy.
      fail(`${code}: the sandbox image or scope changed; redeploy the app to the new sandbox image before installing this receipt`);
    }
    fail(code);
  }
  // <<< pre-write-verification

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });

  const bytes = Buffer.from(attestation, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Atomic install: write a sibling temp file, fix its mode and owner, then
  // rename over the destination so a concurrent reader sees the old or the new
  // receipt, never a partial write.
  const tmp = join(dir, `.attestation.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, bytes, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  if (process.platform !== "win32" && process.getuid?.() === 0) {
    // ssh console runs as root; hand the file to the app uid so the unprivileged
    // app process owns what it reads. Best effort: the 0644 receipt is a public
    // artifact and stays readable even if the chown cannot be applied.
    try {
      chownSync(tmp, 1000, 1000);
    } catch {
      /* non-fatal: file is world-readable */
    }
  }
  renameSync(tmp, path);

  process.stdout.write(
    `${JSON.stringify({ installed: true, path, testedAt, expiresAt, sha256 })}\n`,
  );
}

function isMain(): boolean {
  return Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) installSandboxEgressAttestation();
