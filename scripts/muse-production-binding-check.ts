import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const APPROVED_PRODUCTION_MODEL = Object.freeze({
  provider: "muse-spark",
  model: "muse-spark-1.2-contributor",
});

const REQUIRED_MODEL_BINDINGS = Object.freeze({
  MENDPOINT_MODEL_PROVIDER: APPROVED_PRODUCTION_MODEL.provider,
  LLM_AGENT_MODEL: APPROVED_PRODUCTION_MODEL.model,
  LLM_CONFIRM_MODEL: APPROVED_PRODUCTION_MODEL.model,
  MENDPOINT_LIVE_APPROVED_MODEL: APPROVED_PRODUCTION_MODEL.model,
  MENDPOINT_CHANGE_GRAPH_BENCHMARK_APPROVED_MODEL: APPROVED_PRODUCTION_MODEL.model,
});

export function parseFlyEnv(source: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  let inEnv = false;
  for (const line of source.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inEnv = section[1] === "env";
      continue;
    }
    if (!inEnv || /^\s*(?:#|$)/.test(line)) continue;
    const entry = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"([^"\r\n]*)"\s*$/);
    if (!entry) continue;
    if (values[entry[1]!] !== undefined) throw new Error(`duplicate Fly env binding: ${entry[1]}`);
    values[entry[1]!] = entry[2]!;
  }
  return Object.freeze(values);
}

export function checkMuseProductionBinding(source: string): string[] {
  const env = parseFlyEnv(source);
  return Object.entries(REQUIRED_MODEL_BINDINGS).flatMap(([key, expected]) =>
    env[key] === expected ? [] : [`${key}: expected ${expected}, found ${env[key] ?? "missing"}`],
  );
}

function main(): void {
  const issues = checkMuseProductionBinding(readFileSync(resolve(process.cwd(), "fly.toml"), "utf8"));
  if (issues.length) {
    for (const issue of issues) console.error(`MUSE PRODUCTION BINDING FAIL: ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`MUSE PRODUCTION BINDING PASS: ${APPROVED_PRODUCTION_MODEL.provider}/${APPROVED_PRODUCTION_MODEL.model}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
