import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  GRAPHIFY_EVALUATION_PIN,
  structuralFailure,
  type GraphifyProcessPort,
  type StructuralSnapshotFileV1,
} from "./index.js";

const PROTOCOL_VERSION = "mendpoint.graphify-process.v1";
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const STDERR_LIMIT_BYTES = 64 * 1024;
const RESPONSE_METADATA_BYTES_PER_FILE = 1_024;
const RESPONSE_FIXED_OVERHEAD_BYTES = 64 * 1024;
export const GRAPHIFY_BRIDGE_PIN = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  digest: "sha256:948a114e2197329d2b6d1f7a16799d236761a177ae4992ecbe65c2dc83f12310",
} as const);

type ProcessSource = StructuralSnapshotFileV1 & { bytes: Uint8Array };
type ProcessRequest = {
  snapshotId: string;
  revision: string;
  manifestDigest: string;
  sources: ProcessSource[];
  limits: {
    maxFiles: number;
    maxInputBytes: number;
    maxNodes: number;
    maxEdges: number;
    maxOutputBytes: number;
    maxMemoryBytes: number;
    timeoutMs: number;
    terminationTimeoutMs?: number;
  };
};

type BridgeEnvelope = {
  protocolVersion: string;
  packageVersion: string;
  resourceCeilingEnforced: boolean;
  networkDenied: boolean;
  observedFiles: StructuralSnapshotFileV1[];
  peakMemoryBytes: number;
  output: unknown;
};

export type GraphifyProcessConfig = {
  executablePath: string;
  bridgePath: string;
  bridgeDigest: `sha256:${string}`;
  argumentsBeforeBridge?: string[];
  parentNetworkNamespace?: string;
};

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function digest(value: Buffer | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateExecutableFile(path: string, label: string, allowSymlink = false): string {
  if (!isAbsolute(path)) throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", `${label} path must be absolute`);
  let resolved: string;
  try {
    resolved = realpathSync(path);
    const source = lstatSync(path);
    const target = lstatSync(resolved);
    if (!target.isFile() || (!allowSymlink && source.isSymbolicLink())) throw new Error("not a regular file");
  } catch {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", `${label} is unavailable or unsafe`);
  }
  return resolve(resolved);
}

function validateBridgeEnvelope(value: unknown, request: ProcessRequest): BridgeEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "protocolVersion", "packageVersion", "resourceCeilingEnforced", "networkDenied",
    "observedFiles", "peakMemoryBytes", "output",
  ])) {
    throw structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "Graphify bridge response is malformed");
  }
  const envelope = value as BridgeEnvelope;
  if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.packageVersion !== GRAPHIFY_EVALUATION_PIN.version) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "Graphify bridge identity is not pinned");
  }
  if (envelope.resourceCeilingEnforced !== true || envelope.networkDenied !== true) {
    throw structuralFailure("GRAPHIFY_SECURITY_FAILURE", "Graphify bridge did not prove process containment");
  }
  if (!Number.isSafeInteger(envelope.peakMemoryBytes) || envelope.peakMemoryBytes < 0 || envelope.peakMemoryBytes > request.limits.maxMemoryBytes) {
    throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify bridge exceeded its memory ceiling");
  }
  if (!Array.isArray(envelope.observedFiles) || envelope.observedFiles.length !== request.sources.length) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "Graphify bridge observed-file inventory is incomplete");
  }
  const observed = new Map(envelope.observedFiles.map((entry) => [entry?.path, entry]));
  for (const source of request.sources) {
    const entry = observed.get(source.path);
    if (!entry || !exactKeys(entry, ["path", "contentDigest", "byteLength", "mode", "kind"]) ||
      entry.contentDigest !== source.contentDigest || entry.byteLength !== source.byteLength ||
      entry.mode !== source.mode || entry.kind !== source.kind) {
      throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "Graphify bridge observed different source bytes");
    }
  }
  if (Buffer.byteLength(JSON.stringify(envelope.output), "utf8") > request.limits.maxOutputBytes) {
    throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify bridge output exceeded its byte ceiling");
  }
  return envelope;
}

export function createGraphifyProcessPort(config: GraphifyProcessConfig): GraphifyProcessPort {
  const executablePath = validateExecutableFile(config.executablePath, "Graphify executable", true);
  const bridgePath = validateExecutableFile(config.bridgePath, "Graphify bridge");
  if (!DIGEST_RE.test(config.bridgeDigest) || digest(readFileSync(bridgePath)) !== config.bridgeDigest) {
    throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "Graphify bridge digest does not match admitted bytes");
  }

  const start = (request: ProcessRequest) => {
    const inputBytes = request.sources.reduce((total, source) => total + source.bytes.byteLength, 0);
    if (request.sources.length < 1 || request.sources.length > request.limits.maxFiles || inputBytes > request.limits.maxInputBytes) {
      throw structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify process request exceeds its input ceiling");
    }
    for (const source of request.sources) {
      if (source.bytes.byteLength !== source.byteLength || digest(source.bytes) !== source.contentDigest) {
        throw structuralFailure("GRAPHIFY_IDENTITY_INSTABILITY", "Graphify process source bytes do not match the manifest");
      }
    }
    const wire = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      snapshotId: request.snapshotId,
      revision: request.revision,
      manifestDigest: request.manifestDigest,
      sources: request.sources.map(({ bytes, ...source }) => ({ ...source, bytesBase64: Buffer.from(bytes).toString("base64") })),
      limits: request.limits,
    });
    const responseLimit = request.limits.maxOutputBytes +
      request.limits.maxFiles * RESPONSE_METADATA_BYTES_PER_FILE + RESPONSE_FIXED_OVERHEAD_BYTES;
    const workingDirectory = mkdtempSync(resolve(tmpdir(), "mendpoint-graphify-process-"));
    const child = spawn(executablePath, [...(config.argumentsBeforeBridge ?? []), bridgePath], {
      cwd: workingDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        PYTHONHASHSEED: "0",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        GRAPHIFY_DEBUG: "",
        MENDPOINT_GRAPHIFY_PARENT_NETWORK_NAMESPACE: config.parentNetworkNamespace ?? "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "*",
      },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forcedFailure: Error | undefined;
    let exited = false;
    let exitResolve!: () => void;
    const exitConfirmed = new Promise<void>((resolveExit) => { exitResolve = resolveExit; });

    const failAndStop = (error: Error) => {
      forcedFailure ??= error;
      if (!exited) child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > responseLimit) {
        failAndStop(structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify bridge response exceeded its byte ceiling"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > STDERR_LIMIT_BYTES) {
        failAndStop(structuralFailure("GRAPHIFY_PERFORMANCE_FAILURE", "Graphify bridge diagnostics exceeded their byte ceiling"));
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      forcedFailure ??= structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", `Graphify process failed to start: ${error.message}`);
    });

    const result = new Promise<{
      exitConfirmed: true;
      output: unknown;
      observedFiles: StructuralSnapshotFileV1[];
      peakMemoryBytes: number;
    }>((resolveResult, rejectResult) => {
      child.once("close", (code, signal) => {
        exited = true;
        exitResolve();
        rmSync(workingDirectory, { recursive: true, force: true });
        if (forcedFailure) {
          rejectResult(forcedFailure);
          return;
        }
        if (code !== 0) {
          const diagnostic = Buffer.concat(stderr).toString("utf8")
            .replace(/[^\x20-\x7e]+/gu, " ")
            .trim()
            .slice(0, 512);
          rejectResult(structuralFailure(
            "GRAPHIFY_EXTRACTION_FAILURE",
            `Graphify process exited unsuccessfully (${code ?? signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`,
          ));
          return;
        }
        try {
          const envelope = validateBridgeEnvelope(JSON.parse(Buffer.concat(stdout).toString("utf8")), request);
          resolveResult({
            exitConfirmed: true,
            output: envelope.output,
            observedFiles: envelope.observedFiles,
            peakMemoryBytes: envelope.peakMemoryBytes,
          });
        } catch (error) {
          rejectResult(error instanceof Error && "code" in error
            ? error
            : structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "Graphify bridge response is not valid JSON"));
        }
      });
    });
    child.stdin.once("error", (error) => failAndStop(structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", `Graphify process input failed: ${error.message}`)));
    child.stdin.end(wire, "utf8");

    return {
      result,
      async terminate({ forceAfterMs }: { forceAfterMs: number }): Promise<void> {
        if (exited) return;
        forcedFailure ??= structuralFailure("GRAPHIFY_EXTRACTION_FAILURE", "Graphify process was terminated");
        child.kill("SIGTERM");
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exitConfirmed,
          new Promise<void>((resolveForce) => {
            forceTimer = setTimeout(() => {
              if (!exited) child.kill("SIGKILL");
              resolveForce();
            }, forceAfterMs);
          }),
        ]);
        if (forceTimer) clearTimeout(forceTimer);
        if (!exited) await exitConfirmed;
      },
    };
  };

  return Object.freeze({
    version: GRAPHIFY_EVALUATION_PIN.version,
    digest: GRAPHIFY_EVALUATION_PIN.implementationDigest,
    start,
  });
}

export function createPinnedGraphifyProcessPort(input: {
  pythonExecutablePath: string;
  bridgePath: string;
  unshareExecutablePath?: string;
}): GraphifyProcessPort {
  if (process.platform !== "linux") {
    throw structuralFailure("GRAPHIFY_SECURITY_FAILURE", "the pinned Graphify process requires Linux namespace isolation");
  }
  const pythonExecutablePath = validateExecutableFile(input.pythonExecutablePath, "Graphify Python executable", true);
  const unshareExecutablePath = validateExecutableFile(input.unshareExecutablePath ?? "/usr/bin/unshare", "Graphify namespace launcher", true);
  let parentNetworkNamespace: string;
  try {
    parentNetworkNamespace = readlinkSync("/proc/self/ns/net", "utf8");
  } catch {
    throw structuralFailure("GRAPHIFY_SECURITY_FAILURE", "the parent network namespace cannot be observed");
  }
  return createGraphifyProcessPort({
    executablePath: unshareExecutablePath,
    bridgePath: input.bridgePath,
    bridgeDigest: GRAPHIFY_BRIDGE_PIN.digest,
    argumentsBeforeBridge: ["--user", "--map-root-user", "--net", "--", pythonExecutablePath],
    parentNetworkNamespace,
  });
}
