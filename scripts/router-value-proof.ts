import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { persistRouterValueProofReport } from "@mendpoint/eval";

type RouterValueProofIo = Readonly<{
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}>;

function parseArgs(argv: readonly string[]): Readonly<{ input: string; output: string }> | null {
  const values = new Map<string, string>();
  for (const value of argv) {
    const match = /^--(input|output)=(.+)$/.exec(value);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  const input = values.get("input");
  const output = values.get("output");
  return input && output ? Object.freeze({ input, output }) : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^router_value_[a-z0-9_:.-]+$/.test(message)
    ? message
    : "router_value_io_failed";
}

export function runRouterValueProofCli(
  argv: readonly string[],
  io: RouterValueProofIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): number {
  const args = parseArgs(argv);
  if (!args) {
    io.stderr(`${JSON.stringify({ ok: false, error: "router_value_arguments_invalid" })}\n`);
    return 2;
  }
  try {
    const report = persistRouterValueProofReport(args.input, args.output);
    io.stdout(`${JSON.stringify({
      ok: report.ok,
      cohortId: report.cohortId,
      cohortRevision: report.cohortRevision,
      cohortDigest: report.cohortDigest,
      taskCount: report.taskCount,
      output: resolve(args.output),
    })}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    io.stderr(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`);
    return 2;
  }
}

const isMain = Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) process.exitCode = runRouterValueProofCli(process.argv.slice(2));
