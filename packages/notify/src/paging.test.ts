import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPagingDedupe,
  notifyPaging,
  pagingEventForReadiness,
  pagingEventForWorkerHeartbeat,
} from "./index.js";

beforeEach(() => {
  clearPagingDedupe();
});

afterEach(() => {
  delete process.env.PAGING_WEBHOOK_URL;
  delete process.env.PAGERDUTY_ROUTING_KEY;
  delete process.env.PAGING_DEDUPE_WINDOW_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notifyPaging", () => {
  it("no-ops when neither sink is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await notifyPaging({ type: "readiness_fail", summary: "down" });
    expect(res).toEqual({ ok: true, skipped: true, reason: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a PagerDuty Events v2 payload when a routing key is set", async () => {
    process.env.PAGERDUTY_ROUTING_KEY = "R0UT1NGKEY";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await notifyPaging({
      type: "backup_failure",
      summary: "backup failed",
      details: { backupId: "b-1" },
    });
    expect(res).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      routing_key: "R0UT1NGKEY",
      event_action: "trigger",
      dedup_key: "backup_failure:backup failed",
      payload: {
        summary: "backup failed",
        severity: "critical",
        source: "mendpoint",
        component: "backup_failure",
        custom_details: { backupId: "b-1" },
      },
    });
  });

  it("POSTs a generic webhook payload with the expected shape", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await notifyPaging({
      type: "dr_drill_fail",
      severity: "critical",
      summary: "drill failed",
      dedupeKey: "dr-drill-42",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ops.example.test/hook");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      type: "dr_drill_fail",
      severity: "critical",
      summary: "drill failed",
      dedupeKey: "dr-drill-42",
      source: "mendpoint",
    });
    expect(typeof body.ts).toBe("string");
  });

  it("fans out to both sinks when both are configured", async () => {
    process.env.PAGERDUTY_ROUTING_KEY = "R0UT1NGKEY";
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await notifyPaging({ type: "readiness_fail", summary: "down" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (res.skipped) throw new Error("expected delivery");
    expect(res.deliveries.map((d) => d.sink).sort()).toEqual(["pagerduty", "webhook"]);
    expect(res.ok).toBe(true);
  });

  it("dedupes repeat events within the window", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const first = await notifyPaging({ type: "readiness_fail", summary: "down" });
    const second = await notifyPaging({ type: "readiness_fail", summary: "down" });
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: true, skipped: true, reason: "deduped" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails open when the transport rejects", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await notifyPaging({ type: "backup_failure", summary: "boom" });
    if (res.skipped) throw new Error("expected delivery attempt");
    expect(res.ok).toBe(false);
    expect(res.deliveries[0]).toMatchObject({ sink: "webhook", ok: false, status: 0 });
  });

  it("does not throw when the sink returns a non-2xx status", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await notifyPaging({ type: "backup_failure", summary: "boom" });
    if (res.skipped) throw new Error("expected delivery attempt");
    expect(res.ok).toBe(false);
    expect(res.deliveries[0]).toMatchObject({ sink: "webhook", ok: false, status: 500 });
  });
});

describe("paging adapters", () => {
  it("builds a readiness_fail event only when the probe is failing", () => {
    expect(
      pagingEventForReadiness({ status: "ok", checks: [{ name: "env", ok: true }] }),
    ).toBeNull();
    const event = pagingEventForReadiness({
      status: "fail",
      checks: [
        { name: "env", ok: true },
        { name: "data_dir_writable", ok: false },
        { name: "db_schema", ok: false },
      ],
    });
    expect(event).toMatchObject({
      type: "readiness_fail",
      severity: "critical",
      details: { failedChecks: ["data_dir_writable", "db_schema"] },
    });
  });

  it("prioritizes stale heartbeat, then expired leases, then dead-letter growth", () => {
    expect(
      pagingEventForWorkerHeartbeat({
        workerId: "w1",
        ok: true,
        stale: true,
        deadLetter: 3,
        expiredLeases: 2,
      })?.type,
    ).toBe("worker_heartbeat_stale");
    expect(
      pagingEventForWorkerHeartbeat({
        workerId: "w1",
        ok: true,
        stale: false,
        deadLetter: 3,
        expiredLeases: 2,
      })?.type,
    ).toBe("expired_lease_uncertain_side_effect");
    expect(
      pagingEventForWorkerHeartbeat({
        workerId: "w1",
        ok: true,
        stale: false,
        deadLetter: 3,
        expiredLeases: 0,
      })?.type,
    ).toBe("dead_letter_growth");
    expect(
      pagingEventForWorkerHeartbeat({ workerId: "w1", ok: true, stale: false }),
    ).toBeNull();
  });
});
