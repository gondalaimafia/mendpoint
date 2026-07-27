/**
 * SLO alerts — evaluate latency / dogfood / cost thresholds and emit structured alerts.
 */
export type AlertSeverity = "info" | "warn" | "critical";

export type Alert = {
  id: string;
  ts: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  data?: Record<string, unknown>;
};

export type AlertSink = (a: Alert) => void;

const buffer: Alert[] = [];
const sinks: AlertSink[] = [];

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
  const a: Alert = {
    id: partial.id ?? `alert_${Date.now().toString(36)}`,
    ts: partial.ts ?? new Date().toISOString(),
    severity: partial.severity,
    source: partial.source,
    message: partial.message,
    data: partial.data,
  };
  buffer.push(a);
  if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
  for (const s of sinks) {
    try {
      s(a);
    } catch {
      /* */
    }
  }
  return a;
}

export function recentAlerts(limit = 50): Alert[] {
  return buffer.slice(-limit);
}

export function clearAlerts(): void {
  buffer.length = 0;
}

export function evaluateLatencyAlerts(input: {
  violations: string[];
  ok: boolean;
}): Alert[] {
  const out: Alert[] = [];
  if (!input.ok) {
    out.push(
      emitAlert({
        severity: "warn",
        source: "graph-slo",
        message: `Graph-RAG SLO violations: ${input.violations.join("; ") || "unknown"}`,
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
}): Alert[] {
  const out: Alert[] = [];
  if (input.totalRuns < input.targetRuns) {
    out.push(
      emitAlert({
        severity: "info",
        source: "dogfood",
        message: `Dogfood volume ${input.totalRuns}/${input.targetRuns}`,
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
        data: input,
      }),
    );
  }
  return out;
}

export function evaluateCostAlerts(input: {
  totalUsd: number;
  budgetUsd?: number;
}): Alert[] {
  const budget = input.budgetUsd ?? 10;
  if (input.totalUsd > budget) {
    return [
      emitAlert({
        severity: "warn",
        source: "cost",
        message: `Cost $${input.totalUsd.toFixed(4)} exceeds budget $${budget}`,
        data: input,
      }),
    ];
  }
  return [];
}
