import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlias, isNode, isScalar, LineCounter, parseDocument, visit } from "yaml";

export type MutableActionReference = Readonly<{
  file: string;
  line: number;
  reference: string;
}>;

const IMMUTABLE_GITHUB_ACTION =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;

function workflowFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name);
      return entry.isDirectory() ? workflowFiles(path) : [path];
    })
    .filter((path) => /\.ya?ml$/i.test(path))
    .sort();
}

export function findMutableActionReferences(
  source: string,
  file = "workflow",
): MutableActionReference[] {
  const findings: MutableActionReference[] = [];
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw document.errors[0];

  visit(document, {
    Pair(_key, pair) {
      const resolvedKey = isAlias(pair.key)
        ? pair.key.resolve(document)
        : pair.key;
      if (!isScalar(resolvedKey) || resolvedKey.value !== "uses") return;

      const reference = isScalar(pair.value)
        ? String(pair.value.value).trim()
        : "<non-string>";
      const containsExpression = reference.includes("${{");
      if (!containsExpression && reference.startsWith("./")) return;
      if (IMMUTABLE_GITHUB_ACTION.test(reference)) return;

      const offset = isNode(pair.key) ? pair.key.range?.[0] ?? 0 : 0;
      findings.push(Object.freeze({
        file,
        line: lineCounter.linePos(offset).line,
        reference,
      }));
    },
  });

  return findings;
}

export function checkGitHubActionPins(root: string): MutableActionReference[] {
  return workflowFiles(root).flatMap((file) =>
    findMutableActionReferences(readFileSync(file, "utf8"), file),
  );
}

function main(): void {
  const workflowsRoot = resolve(process.cwd(), ".github", "workflows");
  const findings = checkGitHubActionPins(workflowsRoot);
  if (findings.length > 0) {
    console.error("Mutable GitHub Actions references are forbidden:");
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.reference}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("GitHub Actions pin check passed: every external uses reference has a full commit SHA.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
