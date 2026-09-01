/**
 * File- and method-level change detection & classification.
 *
 * Starts from file diffs (or explicit path lists), classifies methods into
 * body edit / signature change / add / delete, and flags hierarchy, import,
 * and large structural events for broader reset or full rebuild.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallGraph, FunctionNode } from "./types.js";


export type MethodChangeKind =
  | "method_body_edit"
  | "method_signature_change"
  | "method_added"
  | "method_deleted";

export type ClassifiedMethodChange = {
  kind: MethodChangeKind;
  filePath: string;
  methodName: string;
  enclosingType?: string;
  previousNodeId?: string;
  /** Stable key file::type::name */
  stableKey: string;
  previousBodyHash?: string;
  newBodyHash?: string;
  previousSignature?: string;
  newSignature?: string;
};

export type StructuralFlags = {
  hierarchyChanged: boolean;
  importChanged: boolean;
  /** package.json / go.mod / new top-level package paths */
  dependencyManifestChanged: boolean;
  /** large renames / moves / many files */
  largeStructural: boolean;
  newPackagePaths: string[];
};

export type ChangeSet = {
  changedFiles: string[];
  deletedFiles: string[];
  addedFiles: string[];
  methods: ClassifiedMethodChange[];
  structural: StructuralFlags;
  /** 0–1 fraction of previous methods that were added/modified/deleted */
  changedMethodFraction: number;
  previousMethodCount: number;
};

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function methodStableKey(
  filePath: string,
  name: string,
  enclosingType?: string,
): string {
  return `${normPath(filePath)}::${enclosingType ?? ""}::${name}`;
}

function nodeStableKey(n: FunctionNode): string {
  return methodStableKey(n.filePath, n.name, n.enclosingType);
}

/** Rough signature fingerprint from first line of function (params + async/export). */
export function signatureFingerprint(body: string, name: string): string {
  const first = body.split(/\r?\n/).find((l) => l.includes(name)) ?? body.slice(0, 200);
  // strip body braces content
  return first
    .replace(/\s+/g, " ")
    .replace(/\{.*$/, "")
    .replace(/:\s*[^=]+(?==>)/, "") // strip TS return in arrows lightly
    .trim()
    .slice(0, 240);
}

function hashBody(body: string): string {
  // Must match packages/call-graph/src/build.ts hashBody
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}


type ExtractedMethod = {
  name: string;
  enclosingType?: string;
  body: string;
  bodyHash: string;
  signature: string;
  lineStart: number;
};

/**
 * Extract methods from a source file (aligned with build.ts heuristics).
 */
export function extractMethodsFromSource(
  filePath: string,
  text: string,
): ExtractedMethod[] {
  const rel = normPath(filePath);
  const language = rel.endsWith(".py")
    ? "python"
    : /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)
      ? "js"
      : "other";
  const lines = text.split(/\r?\n/);
  const out: ExtractedMethod[] = [];

  if (language === "python") {
    let className: string | undefined;
    let classIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const cls = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (cls) {
        className = cls[2];
        classIndent = cls[1]!.length;
        continue;
      }
      const m = line.match(/^(\s*)def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!m) continue;
      const indent = m[1]!.length;
      if (className !== undefined && indent <= classIndent) {
        className = undefined;
        classIndent = -1;
      }
      const name = m[2]!;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() === "") continue;
        const ind = l.match(/^\s*/)?.[0].length ?? 0;
        if (ind <= indent && /^(def|class)\s+/.test(l.trim())) {
          end = j;
          break;
        }
      }
      const body = lines.slice(i, end).join("\n");
      out.push({
        name,
        enclosingType: className && indent > classIndent ? className : undefined,
        body,
        bodyHash: hashBody(body),
        signature: signatureFingerprint(body, name),
        lineStart: i + 1,
      });
    }
    return out;
  }

  let enclosingType: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cls = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cls) enclosingType = cls[1];

    let name: string | null = null;
    let isMethod = false;
    const m1 = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    const m2 = line.match(
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/,
    );
    const m3 = line.match(/^\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/);
    if (m1) name = m1[1]!;
    else if (m2) name = m2[1]!;
    else if (m3 && enclosingType && !/^(if|for|while|switch|catch)$/.test(m3[1]!)) {
      name = m3[1]!;
      isMethod = true;
    }
    if (!name) continue;

    let depth = 0;
    let started = false;
    let end = i + 1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") depth--;
      }
      end = j + 1;
      if (started && depth <= 0) break;
      if (!started && j === i && !line.includes("{") && line.includes("=>")) {
        end = j + 1;
        break;
      }
    }
    const body = lines.slice(i, end).join("\n");
    out.push({
      name,
      enclosingType: isMethod ? enclosingType : undefined,
      body,
      bodyHash: hashBody(body),
      signature: signatureFingerprint(body, name),
      lineStart: i + 1,
    });
  }
  return out;
}

function fileHasHierarchySignal(text: string): boolean {
  return (
    /\bclass\s+[A-Za-z_]/.test(text) ||
    /\bextends\s+[A-Za-z_]/.test(text) ||
    /\bimplements\s+[A-Za-z_]/.test(text) ||
    /\binterface\s+[A-Za-z_]/.test(text)
  );
}

function fileHasImportSignal(text: string, previousText?: string): boolean {
  if (!previousText) {
    return /^\s*(import|from|require)\b/m.test(text);
  }
  const imp = (s: string) =>
    [...s.matchAll(/^\s*(?:import|from|require).*$/gm)].map((m) => m[0]).join("\n");
  return imp(text) !== imp(previousText);
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "Gemfile",
]);

/**
 * Classify method-level changes for a set of changed file paths against the previous graph.
 */
export function classifyChanges(
  previous: CallGraph,
  changedFiles: string[],
  opts?: {
    previousFileTexts?: Record<string, string>;
    sources?: ReadonlyMap<string, string>;
  },
): ChangeSet {
  const repoRoot = previous.repoRoot;
  const files = [...new Set(changedFiles.map(normPath))];
  const deletedFiles: string[] = [];
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const methods: ClassifiedMethodChange[] = [];

  let hierarchyChanged = false;
  let importChanged = false;
  let dependencyManifestChanged = false;
  const newPackagePaths: string[] = [];

  const prevByKey = new Map<string, FunctionNode>();
  for (const n of Object.values(previous.nodes)) {
    prevByKey.set(nodeStableKey(n), n);
  }
  const previousMethodCount = prevByKey.size || 1;
  const touchedKeys = new Set<string>();

  for (const filePath of files) {
    const abs = join(repoRoot, filePath);
    const base = filePath.split("/").pop() ?? filePath;
    if (MANIFEST_NAMES.has(base)) dependencyManifestChanged = true;

    // new package path heuristic: first segment not seen before
    const top = filePath.split("/")[0];
    if (
      top &&
      ["packages", "apps", "services", "libs"].includes(top) &&
      !Object.values(previous.nodes).some((n) => n.filePath.startsWith(top + "/"))
    ) {
      newPackagePaths.push(filePath);
    }

    const capturedText = opts?.sources?.get(resolve(abs));
    if (opts?.sources ? capturedText === undefined : !existsSync(abs)) {
      deletedFiles.push(filePath);
      for (const n of Object.values(previous.nodes)) {
        if (n.filePath !== filePath) continue;
        const key = nodeStableKey(n);
        touchedKeys.add(key);
        methods.push({
          kind: "method_deleted",
          filePath,
          methodName: n.name,
          enclosingType: n.enclosingType,
          previousNodeId: n.id,
          stableKey: key,
          previousBodyHash: n.bodyHash,
          previousSignature: n.signature,
        });
      }
      continue;
    }

    const text = capturedText ?? readFileSync(abs, "utf8");
    const prevText = opts?.previousFileTexts?.[filePath];
    if (fileHasHierarchySignal(text)) hierarchyChanged = true;
    if (fileHasImportSignal(text, prevText)) importChanged = true;

    const hadAny = Object.values(previous.nodes).some((n) => n.filePath === filePath);
    if (!hadAny) addedFiles.push(filePath);
    else modifiedFiles.push(filePath);

    const extracted = extractMethodsFromSource(filePath, text);
    const seenInFile = new Set<string>();

    for (const m of extracted) {
      const key = methodStableKey(filePath, m.name, m.enclosingType);
      seenInFile.add(key);
      touchedKeys.add(key);
      const prev = prevByKey.get(key);
      if (!prev) {
        methods.push({
          kind: "method_added",
          filePath,
          methodName: m.name,
          enclosingType: m.enclosingType,
          stableKey: key,
          newBodyHash: m.bodyHash,
          newSignature: m.signature,
        });
        continue;
      }
      const prevSig = prev.signature ?? "";
      const prevHash = prev.bodyHash ?? "";
      if (prevSig && prevSig !== m.signature) {
        methods.push({
          kind: "method_signature_change",
          filePath,
          methodName: m.name,
          enclosingType: m.enclosingType,
          previousNodeId: prev.id,
          stableKey: key,
          previousBodyHash: prevHash,
          newBodyHash: m.bodyHash,
          previousSignature: prevSig,
          newSignature: m.signature,
        });
      } else if (prevHash && prevHash !== m.bodyHash) {
        methods.push({
          kind: "method_body_edit",
          filePath,
          methodName: m.name,
          enclosingType: m.enclosingType,
          previousNodeId: prev.id,
          stableKey: key,
          previousBodyHash: prevHash,
          newBodyHash: m.bodyHash,
          previousSignature: prevSig || m.signature,
          newSignature: m.signature,
        });
      } else if (!prevHash) {
        // no prior hash — treat as body edit to be safe
        methods.push({
          kind: "method_body_edit",
          filePath,
          methodName: m.name,
          enclosingType: m.enclosingType,
          previousNodeId: prev.id,
          stableKey: key,
          newBodyHash: m.bodyHash,
          newSignature: m.signature,
        });
      }
    }

    // deletions within modified file
    for (const n of Object.values(previous.nodes)) {
      if (n.filePath !== filePath) continue;
      const key = nodeStableKey(n);
      if (seenInFile.has(key)) continue;
      touchedKeys.add(key);
      methods.push({
        kind: "method_deleted",
        filePath,
        methodName: n.name,
        enclosingType: n.enclosingType,
        previousNodeId: n.id,
        stableKey: key,
        previousBodyHash: n.bodyHash,
        previousSignature: n.signature,
      });
    }
  }

  const largeStructural =
    dependencyManifestChanged ||
    newPackagePaths.length > 0 ||
    files.length >= 12 ||
    deletedFiles.length + addedFiles.length >= 5;

  const changedMethodFraction = Math.min(1, touchedKeys.size / previousMethodCount);

  return {
    changedFiles: modifiedFiles,
    deletedFiles,
    addedFiles,
    methods,
    structural: {
      hierarchyChanged,
      importChanged,
      dependencyManifestChanged,
      largeStructural,
      newPackagePaths,
    },
    changedMethodFraction,
    previousMethodCount,
  };
}

/**
 * Heuristic: should we full-rebuild given a change set?
 * Thresholds follow practical guidance (~15–30% methods, structural events).
 */
export function shouldFullRebuildFromChangeSet(
  cs: ChangeSet,
  opts?: {
    methodFractionThreshold?: number;
    forceStructural?: boolean;
  },
): { full: boolean; reason?: string } {
  const thr = opts?.methodFractionThreshold ?? 0.25;
  if (cs.changedMethodFraction >= thr) {
    return {
      full: true,
      reason: `changed_method_fraction_${cs.changedMethodFraction.toFixed(2)}>=${thr}`,
    };
  }
  if (opts?.forceStructural !== false && cs.structural.largeStructural) {
    return { full: true, reason: "large_structural_change" };
  }
  if (cs.structural.dependencyManifestChanged) {
    return { full: true, reason: "dependency_manifest_changed" };
  }
  return { full: false };
}
