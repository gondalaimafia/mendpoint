#!/usr/bin/env node
/**
 * Operator-only builder/pusher for the Mendpoint sandbox runtime image
 * (Dockerfile.sandbox). This script is NEVER invoked automatically — there is no
 * CI step, npm lifecycle hook, or postinstall that runs it. An operator with a
 * working `docker` + `flyctl` and Fly registry access runs it by hand.
 *
 *   node scripts/build-sandbox-image.mjs             # build only (local, safe)
 *   node scripts/build-sandbox-image.mjs --push      # build + push :<tag> and :latest
 *   node scripts/build-sandbox-image.mjs --dry-run   # print the commands, run nothing
 *   node scripts/build-sandbox-image.mjs --tag=v3    # override the tag
 *
 * The tag defaults to a content hash of Dockerfile.sandbox, so an identical
 * image definition always produces the same immutable tag. `:latest` is pushed
 * alongside the immutable tag. Pushing requires the explicit --push flag.
 *
 * Target registry: registry.fly.io/mendpoint-sandbox
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = resolve(repoRoot, "Dockerfile.sandbox");
const IMAGE = "registry.fly.io/mendpoint-sandbox";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const dryRun = has("--dry-run");
const push = has("--push");
const tagArg = argv.find((a) => a.startsWith("--tag="));

function contentTag() {
  const digest = createHash("sha256").update(readFileSync(dockerfile)).digest("hex");
  return `sha-${digest.slice(0, 12)}`;
}

const tag = tagArg ? tagArg.slice("--tag=".length) : process.env.TAG || contentTag();
const taggedRef = `${IMAGE}:${tag}`;
const latestRef = `${IMAGE}:latest`;

function run(cmd, cmdArgs) {
  console.log(`+ ${[cmd, ...cmdArgs].join(" ")}`);
  if (dryRun) return;
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: repoRoot, shell: false });
  if (res.error) {
    console.error(`failed to run ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log(`sandbox image: ${taggedRef}`);
console.log(`               ${latestRef}`);
console.log(
  dryRun
    ? "(dry run — no commands executed)"
    : push
      ? "(build + push)"
      : "(build only — pass --push to publish)",
);

run("docker", ["build", "-f", dockerfile, "-t", taggedRef, "-t", latestRef, repoRoot]);

if (push) {
  // Configure docker to authenticate against the Fly registry, then push both
  // tags. `flyctl auth docker` uses the operator's already-authenticated flyctl
  // session — no credentials are read or written by this script.
  run("flyctl", ["auth", "docker"]);
  run("docker", ["push", taggedRef]);
  run("docker", ["push", latestRef]);
  // Print the immutable digest so the operator can pin
  // MENDPOINT_SANDBOX_FLY_IMAGE to registry.fly.io/mendpoint-sandbox@sha256:...
  run("docker", ["inspect", "--format={{index .RepoDigests 0}}", taggedRef]);
}
