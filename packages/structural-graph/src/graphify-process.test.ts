import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GRAPHIFY_EVALUATION_PIN, type GraphifyProcessPort } from "./index.js";
import { GRAPHIFY_BRIDGE_PIN, createGraphifyProcessPort } from "./graphify-process.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

const sha256 = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function fixture(source: string): { path: string; digest: `sha256:${string}` } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-graphify-process-"));
  directories.push(root);
  const path = join(root, "bridge.mjs");
  writeFileSync(path, source, "utf8");
  return { path, digest: sha256(source) as `sha256:${string}` };
}

const successFixture = String.raw`
import { createHash } from "node:crypto";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const observedFiles = request.sources.map((source) => ({
    path: source.path,
    contentDigest: "sha256:" + createHash("sha256").update(Buffer.from(source.bytesBase64, "base64")).digest("hex"),
    byteLength: Buffer.from(source.bytesBase64, "base64").byteLength,
    mode: source.mode,
    kind: source.kind,
  }));
  process.stdout.write(JSON.stringify({
    protocolVersion: "mendpoint.graphify-process.v1",
    packageVersion: "0.9.46",
    resourceCeilingEnforced: true,
    networkDenied: true,
    observedFiles,
    peakMemoryBytes: 4096,
    output: { nodes: [], edges: [], failed_sources: [], unsupported_languages: [], warnings: [], privateCwd: process.cwd() },
  }));
});
`;

function request() {
  const bytes = Buffer.from("export function value() { return 1; }", "utf8");
  return {
    snapshotId: "snapshot-a",
    revision: "a".repeat(40),
    manifestDigest: sha256("manifest") as `sha256:${string}`,
    sources: [{
      path: "src/value.ts",
      contentDigest: sha256(bytes) as `sha256:${string}`,
      byteLength: bytes.byteLength,
      mode: "100644" as const,
      kind: "file" as const,
      bytes: new Uint8Array(bytes),
    }],
    limits: {
      maxFiles: 1,
      maxInputBytes: 16_384,
      maxNodes: 100,
      maxEdges: 100,
      maxOutputBytes: 16_384,
      maxMemoryBytes: 64 * 1024 * 1024,
      timeoutMs: 5_000,
      terminationTimeoutMs: 1_000,
    },
  };
}

describe("Graphify process supervisor", () => {
  it("binds the pinned factory to the checked-in bridge bytes", () => {
    expect(sha256(readFileSync(join(process.cwd(), "python", "graphify_bridge.py")))).toBe(GRAPHIFY_BRIDGE_PIN.digest);
  });

  it("binds exact source bytes to a bounded, exited child result", async () => {
    const bridge = fixture(successFixture);
    const port: GraphifyProcessPort = createGraphifyProcessPort({
      executablePath: process.execPath,
      bridgePath: bridge.path,
      bridgeDigest: bridge.digest,
    });

    const completed = await port.start(request()).result;
    expect(completed).toEqual({
      exitConfirmed: true,
      observedFiles: request().sources.map(({ bytes: _bytes, ...source }) => source),
      peakMemoryBytes: 4096,
      output: expect.objectContaining({ nodes: [], edges: [], failed_sources: [], unsupported_languages: [], warnings: [] }),
    });
    const privateCwd = (completed.output as { privateCwd: string }).privateCwd;
    expect(privateCwd).not.toBe(dirname(bridge.path));
    expect(existsSync(privateCwd)).toBe(false);
    expect(port.version).toBe(GRAPHIFY_EVALUATION_PIN.version);
    expect(port.digest).toBe(GRAPHIFY_EVALUATION_PIN.implementationDigest);
  });

  it("rejects a bridge whose bytes do not match its admitted digest", () => {
    const bridge = fixture(successFixture);
    expect(() => createGraphifyProcessPort({
      executablePath: process.execPath,
      bridgePath: bridge.path,
      bridgeDigest: `sha256:${"0".repeat(64)}`,
    })).toThrow("GRAPHIFY_IDENTITY_INSTABILITY");
  });

  it("fails closed when the child cannot prove resource and network containment", async () => {
    const unsafe = successFixture.replace("resourceCeilingEnforced: true", "resourceCeilingEnforced: false");
    const bridge = fixture(unsafe);
    const operation = createGraphifyProcessPort({
      executablePath: process.execPath,
      bridgePath: bridge.path,
      bridgeDigest: bridge.digest,
    }).start(request());
    await expect(operation.result).rejects.toThrow("GRAPHIFY_SECURITY_FAILURE");
  });

  it("kills and confirms child exit before acknowledging termination", async () => {
    const bridge = fixture("setInterval(() => undefined, 1000);\n");
    const operation = createGraphifyProcessPort({
      executablePath: process.execPath,
      bridgePath: bridge.path,
      bridgeDigest: bridge.digest,
    }).start(request());
    await expect(operation.terminate({ forceAfterMs: 500 })).resolves.toBeUndefined();
    await expect(operation.result).rejects.toThrow("GRAPHIFY_EXTRACTION_FAILURE");
  });

  it("stops reading when the child exceeds the output byte ceiling", async () => {
    const bridge = fixture("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(100000)));\n");
    const operation = createGraphifyProcessPort({
      executablePath: process.execPath,
      bridgePath: bridge.path,
      bridgeDigest: bridge.digest,
    }).start(request());
    await expect(operation.result).rejects.toThrow("GRAPHIFY_PERFORMANCE_FAILURE");
  });
});
