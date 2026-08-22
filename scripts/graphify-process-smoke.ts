import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GraphifyStructuralExtractor,
  structuralSnapshotManifestDigest,
  type StructuralSnapshotFileV1,
} from "../packages/structural-graph/src/index.js";
import { createPinnedGraphifyProcessPort } from "../packages/structural-graph/src/graphify-process.js";

const sha256 = (value: Buffer | string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const packageRoot = resolve(process.cwd(), "packages", "structural-graph");
const snapshotRoot = mkdtempSync(join(tmpdir(), "mendpoint-graphify-smoke-"));
const sources = new Map([
  ["src/client.ts", Buffer.from("export function request() { return 200; }\n", "utf8")],
  ["src/wrapper.ts", Buffer.from("import { request } from './client.js';\nexport function wrapped() { return request(); }\n", "utf8")],
]);

try {
  const files: StructuralSnapshotFileV1[] = [];
  for (const [path, bytes] of sources) {
    const absolute = join(snapshotRoot, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
    files.push({
      path,
      contentDigest: sha256(bytes),
      byteLength: bytes.byteLength,
      mode: "100644",
      kind: "file",
    });
  }
  const port = createPinnedGraphifyProcessPort({
    pythonExecutablePath: process.env.GRAPHIFY_PYTHON ?? resolve(process.cwd(), ".graphify-venv", "bin", "python"),
    bridgePath: resolve(packageRoot, "python", "graphify_bridge.py"),
  });
  const extraction = await new GraphifyStructuralExtractor(port).extract({
    tenantId: "tenant_graphify_smoke",
    repositoryId: "repository_graphify_smoke",
    snapshotId: "snapshot_graphify_smoke",
    revision: "a".repeat(40),
    manifestDigest: structuralSnapshotManifestDigest(files),
    verifiedSnapshotRoot: snapshotRoot,
    files,
    observedAt: new Date().toISOString(),
    limits: {
      maxFiles: 2,
      maxInputBytes: 64 * 1024,
      maxNodes: 1_000,
      maxEdges: 2_000,
      maxOutputBytes: 8 * 1024 * 1024,
      maxMemoryBytes: 2 * 1024 * 1024 * 1024,
      timeoutMs: 60_000,
      terminationTimeoutMs: 2_000,
    },
  });
  if (extraction.nodes.length < 2 || extraction.sourceFiles.length !== files.length) {
    throw new Error("graphify_process_smoke_incomplete");
  }
  const record = {
    schemaVersion: "mendpoint.graphify-process-smoke.v1",
    status: "verified",
    extractor: extraction.extractor,
    sourceFileCount: extraction.sourceFiles.length,
    nodeCount: extraction.nodes.length,
    edgeCount: extraction.edges.length,
    elapsedMs: extraction.metrics.elapsedMs,
    peakMemoryBytes: extraction.metrics.peakMemoryBytes,
    contentDigest: extraction.contentDigest,
    observedAt: extraction.observedAt,
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (process.env.GRAPHIFY_SMOKE_OUTPUT) {
    mkdirSync(dirname(resolve(process.env.GRAPHIFY_SMOKE_OUTPUT)), { recursive: true });
    writeFileSync(resolve(process.env.GRAPHIFY_SMOKE_OUTPUT), serialized, "utf8");
  }
  process.stdout.write(serialized);
} finally {
  rmSync(snapshotRoot, { recursive: true, force: true });
}
