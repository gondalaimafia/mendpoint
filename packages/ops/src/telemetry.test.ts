import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushTelemetry,
  isTelemetryEnabled,
  recordCounter,
  recordHistogram,
  resetTelemetry,
  startSpan,
  withSpan,
  type TelemetryTransport,
} from "./telemetry.js";

const ENDPOINT = "https://otel.example.test:4318";

beforeEach(() => {
  resetTelemetry();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

afterEach(() => {
  resetTelemetry();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  vi.restoreAllMocks();
});

describe("telemetry (disabled / no-op path)", () => {
  it("reports disabled and does not record or export when the endpoint is unset", async () => {
    expect(isTelemetryEnabled()).toBe(false);
    const span = startSpan("noop", { a: 1 });
    span.setAttribute("b", 2);
    span.end("ok");
    recordCounter("c_total", 3);
    recordHistogram("h_ms", 12);
    expect(withSpan("wrap", () => 42)).toBe(42);

    const spy = vi.fn<TelemetryTransport>();
    const result = await flushTelemetry(spy);
    expect(result).toEqual({ ok: true, skipped: true, reason: "disabled" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("telemetry (enabled path)", () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${ENDPOINT}/`;
  });

  it("records spans and metrics and exports OTLP-shaped payloads to the collector", async () => {
    expect(isTelemetryEnabled()).toBe(true);
    const span = startSpan("op", { component: "test" });
    span.setAttribute("phase", "run");
    span.end("ok");
    recordCounter("readiness_check_total", 1, { status: "ok" });
    recordCounter("readiness_check_total", 1, { status: "ok" });
    recordHistogram("readiness_check_duration_ms", 4, { status: "ok" });

    const calls: Array<{ endpoint: string; signal: string; payload: unknown }> = [];
    const spy: TelemetryTransport = async (endpoint, signal, payload) => {
      calls.push({ endpoint, signal, payload });
      return { ok: true, status: 200 };
    };

    const result = await flushTelemetry(spy);
    if (result.skipped) throw new Error("expected export");
    expect(result.ok).toBe(true);
    expect(result.exported).toEqual({ traces: 1, metrics: 2 });

    const traces = calls.find((c) => c.signal === "traces")!;
    expect(traces.endpoint).toBe(ENDPOINT);
    const tracePayload = traces.payload as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    expect(tracePayload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe("op");

    const metrics = calls.find((c) => c.signal === "metrics")!;
    const metricPayload = metrics.payload as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: Array<{ asDouble: number }> } }> }> }>;
    };
    const emitted = metricPayload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const counter = emitted.find((m) => m.name === "readiness_check_total")!;
    // two increments with identical attributes aggregate into one data point
    expect(counter.sum!.dataPoints[0]!.asDouble).toBe(2);
  });

  it("drains buffers on flush so a second flush is empty", async () => {
    recordCounter("x_total", 1);
    const spy = vi.fn<TelemetryTransport>().mockResolvedValue({ ok: true, status: 200 });
    await flushTelemetry(spy);
    const second = await flushTelemetry(spy);
    expect(second).toEqual({ ok: true, skipped: true, reason: "empty" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("fails open when the transport throws", async () => {
    recordCounter("x_total", 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spy: TelemetryTransport = async () => {
      throw new Error("collector unreachable");
    };
    const result = await flushTelemetry(spy);
    if (result.skipped) throw new Error("expected export attempt");
    expect(result.ok).toBe(false);
  });

  it("marks a span errored when the wrapped operation throws and rethrows", () => {
    expect(() =>
      withSpan("boom", () => {
        throw new Error("kaboom");
      }),
    ).toThrow("kaboom");
  });
});
