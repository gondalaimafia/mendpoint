/**
 * SLO alerts — in-memory + durable JSONL persistence.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type AlertSeverity = "info" | "warn" | "critical";

export type Alert = {
  id: string;
  ts: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  tenantId?: string;
  data?: Record<string, unknown>;
};

export type AlertSink = (a: Alert) => void;

const buffer: Alert[] = [];
const sinks: AlertSink[] = [];
let persistPath: string | null = null;
let loaded = false;

export function setAlertPersistPath(path: string | null): void {
  persistPath = path;
  loaded = false;
}

export function defaultAlertPath(cwd = process.cwd()): string {
  return (
    process.env.MENDPOINT_ALERTS_PATH ??
    join(cwd, "data", "alerts.jsonl")
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const path = persistPath ?? defaultAlertPath();
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    const seen = new Set(buffer.map((a) => a.id));
    for (const line of lines.slice(-500)) {
      try {
        const a = JSON.parse(line) as Alert;
        if (a?.id && !seen.has(a.id)) {
          buffer.push(a);
          seen.add(a.id);
        }
      } catch {
        /* skip */
      }
    }
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
  } catch {
    /* */
  }
}

function persist(a: Alert): void {
  const path = persistPath ?? defaultAlertPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(a) + "\n", "utf8");
  } catch {
    /* disk optional */
  }
}

export function onAlert(sink: AlertSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

export function emitAlert(
  partial: Omit<Alert, "id" | "ts"> & { id?: string; ts?: string },
): Alert {
  ensureLoaded();
  if (partial.tenantId !== undefined && partial.tenantId.trim() === "") {
    throw new Error("Tenant scope required");
  }
  const a: Alert = {
    id: partial.id ?? `alert_${Date.now().toString(36)}`,
    ts: partial.ts ?? new Date().toISOString(),
    severity: partial.severity,
    source: partial.source,
    message: partial.message,
    tenantId: partial.tenantId,
    data: partial.data,
  };
  buffer.push(a);
  if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
  persist(a);
  for (const s of sinks) {
    try {
      s(a);
    } catch {
      /* */
    }
  }
  return a;
}

export function recentAlerts(
  limit = 50,
  scope?: Readonly<{ tenantId: string; includeUnscoped?: boolean }>,
): Alert[] {
  ensureLoaded();
  if (!scope) return buffer.slice(-limit);
  if (scope.tenantId.trim() === "") throw new Error("Tenant scope required");
  return buffer
    .filter((alert) =>
      alert.tenantId === scope.tenantId ||
      (scope.includeUnscoped === true && alert.tenantId === undefined),
    )
    .slice(-limit);
}

export function clearAlerts(opts?: { wipeFile?: boolean }): void {
  buffer.length = 0;
  if (opts?.wipeFile) {
    const path = persistPath ?? defaultAlertPath();
    try {
      writeFileSync(path, "", "utf8");
    } catch {
      /* */
    }
  }
}

export function evaluateLatencyAlerts(input: {
  violations: string[];
  ok: boolean;
  tenantId?: string;
}): Alert[] {
  const out: Alert[] = [];
  if (!input.ok) {
    out.push(
      emitAlert({
        severity: "warn",
        source: "graph-slo",
        message: `Graph-RAG SLO violations: ${input.violations.join("; ") || "unknown"}`,
        tenantId: input.tenantId,
        data: { violations: input.violations },
      }),
    );
  }
  return out;
}

export function evaluateDogfoodAlerts(input: {
  totalRuns: number;
  okRate: number;
  targetRuns: number;
  targetOkRate: number;
  day90Ready: boolean;
  tenantId?: string;
}): Alert[] {
  const out: Alert[] = [];
  if (input.totalRuns < input.targetRuns) {
    out.push(
      emitAlert({
        severity: "info",
        source: "dogfood",
        message: `Dogfood volume ${input.totalRuns}/${input.targetRuns}`,
        tenantId: input.tenantId,
        data: input,
      }),
    );
  }
  if (input.totalRuns >= 5 && input.okRate < input.targetOkRate) {
    out.push(
      emitAlert({
        severity: "critical",
        source: "dogfood",
        message: `Dogfood okRate ${(input.okRate * 100).toFixed(0)}% below target — freeze features`,
        tenantId: input.tenantId,
        data: input,
      }),
    );
  }
  if (input.day90Ready) {
    out.push(
      emitAlert({
        severity: "info",
        source: "dogfood",
        message: "Day-90 dogfood gates met",
        tenantId: input.tenantId,
        data: input,
      }),
    );
  }
  return out;
}

export function evaluateCostAlerts(input: {
  totalUsd: number;
  budgetUsd?: number;
  tenantId?: string;
}): Alert[] {
  const budget = input.budgetUsd ?? 10;
  if (input.totalUsd > budget) {
    return [
      emitAlert({
        severity: "warn",
        source: "cost",
        message: `Cost $${input.totalUsd.toFixed(4)} exceeds budget $${budget}`,
        tenantId: input.tenantId,
        data: input,
      }),
    ];
  }
  return [];
}
