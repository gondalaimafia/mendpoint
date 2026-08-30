import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPagingDedupe,
  notifyPaging,
  pageEgressReceiptFreshness,
  pageEgressReceiptRenewalFailed,
  pageReadiness,
  pageWorkerHeartbeat,
  pagingEventForEgressReceipt,
  pagingEventForReadiness,
  pagingEventForWorkerHeartbeat,
  pagingEventsForWorkerHeartbeat,
} from "./index.js";

beforeEach(() => {
  clearPagingDedupe();
});

afterEach(() => {
  delete process.env.PAGING_WEBHOOK_URL;
  delete process.env.PAGING_DEDUPE_WINDOW_MS;
  delete process.env.MENDPOINT_NOTIFY_TIMEOUT_MS;
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

  it("does not stamp the dedupe key on total failure, so the next call retries", async () => {
    // Reproduces the defect: a transient 502 used to burn the dedupe key, so the
    // 30s retry returned {skipped:true, reason:"deduped"} and nobody was paged.
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await notifyPaging({ type: "readiness_fail", summary: "down" });
    const second = await notifyPaging({ type: "readiness_fail", summary: "down" });

    if (first.skipped) throw new Error("expected a delivery attempt");
    expect(first.ok).toBe(false);
    if (second.skipped) throw new Error("retry must not be deduped after a failed page");
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("classifies a fresh degraded release-dispatch heartbeat separately from stale", () => {
    const event = pagingEventForWorkerHeartbeat({
      workerId: "w1",
      ok: false,
      stale: false,
      releaseDispatchDegraded: true,
      releaseDispatchPending: 7,
      releaseDispatchClaimed: 2,
      releaseDispatchFailed: 3,
      releaseDispatchDue: 5,
      releaseDispatchExpiredClaims: 1,
    });

    expect(event).toMatchObject({
      type: "release_dispatch_degraded",
      severity: "critical",
      dedupeKey: "release_dispatch_degraded:w1",
      details: { pending: 7, claimed: 2, failed: 3, due: 5, expiredClaims: 1 },
    });
    expect(event?.type).not.toBe("worker_heartbeat_stale");
  });

  it("preserves unknown release-dispatch counts instead of reporting false zeroes", () => {
    expect(pagingEventForWorkerHeartbeat({
      workerId: "w1",
      ok: false,
      stale: false,
      releaseDispatchDegraded: true,
      releaseDispatchPending: null,
      releaseDispatchClaimed: null,
      releaseDispatchFailed: null,
      releaseDispatchDue: null,
      releaseDispatchExpiredClaims: null,
    })).toMatchObject({
      type: "release_dispatch_degraded",
      details: { pending: null, claimed: null, failed: null, due: null, expiredClaims: null },
    });
  });

  it("keeps stale feed and release dispatch degradation as independent pages", () => {
    expect(pagingEventsForWorkerHeartbeat({
      workerId: "w1",
      ok: false,
      stale: true,
      releaseDispatchDegraded: true,
      releaseDispatchPending: null,
      releaseDispatchClaimed: null,
      releaseDispatchFailed: null,
      releaseDispatchDue: null,
      releaseDispatchExpiredClaims: null,
      releaseDispatchFailureStage: "claim",
      releaseDispatchFailureCode: "release_dispatch_claim_unavailable",
    })).toEqual([
      expect.objectContaining({ type: "worker_heartbeat_stale" }),
      expect.objectContaining({
        type: "release_dispatch_degraded",
        details: expect.objectContaining({
          failureStage: "claim",
          failureCode: "release_dispatch_claim_unavailable",
        }),
      }),
    ]);
  });

  it("emits every simultaneous critical heartbeat condition with an independent dedupe key", () => {
    const events = pagingEventsForWorkerHeartbeat({
      workerId: "w-compound",
      ok: false,
      stale: true,
      expiredLeases: 2,
      deadLetter: 3,
      releaseDispatchDegraded: true,
      releaseDispatchFailureStage: "claim",
      releaseDispatchFailureCode: "release_dispatch_claim_unavailable",
    });
    expect(events.map((event) => event.type)).toEqual([
      "worker_heartbeat_stale",
      "release_dispatch_degraded",
      "expired_lease_uncertain_side_effect",
      "dead_letter_growth",
    ]);
    expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(4);
  });
});

describe("paging best-effort wiring", () => {
  it("pages when a worker heartbeat snapshot is stale (the real emitHeartbeat path)", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pageWorkerHeartbeat({
      workerId: "w1",
      ok: false,
      stale: true,
      deadLetter: 4,
    });
    if (!res || res.skipped) throw new Error("expected a delivered page");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).type)).toEqual([
      "worker_heartbeat_stale",
      "dead_letter_growth",
    ]);
  });

  it("does not page for a healthy worker heartbeat", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await pageWorkerHeartbeat({ workerId: "w1", ok: true, stale: false });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages a fresh release-dispatch degradation with its own event type", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pageWorkerHeartbeat({
      workerId: "w1",
      ok: false,
      stale: false,
      releaseDispatchDegraded: true,
      releaseDispatchPending: 4,
      releaseDispatchClaimed: 1,
      releaseDispatchFailed: 2,
      releaseDispatchDue: 3,
      releaseDispatchExpiredClaims: 1,
    });
    if (!res || res.skipped) throw new Error("expected a delivered page");
    expect(res.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.type).toBe("release_dispatch_degraded");
    expect(body.details).toEqual({
      pending: 4, claimed: 1, failed: 2, due: 3, expiredClaims: 1,
      failureStage: null, failureCode: null,
    });
  });

  it("delivers stale-feed and release-dispatch degradation as two independent pages", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pageWorkerHeartbeat({
      workerId: "w-compound",
      ok: false,
      stale: true,
      releaseDispatchDegraded: true,
      releaseDispatchFailureStage: "claim",
      releaseDispatchFailureCode: "release_dispatch_claim_unavailable",
    });
    if (!res || res.skipped) throw new Error("expected delivered pages");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).type)).toEqual([
      "worker_heartbeat_stale",
      "release_dispatch_degraded",
    ]);
  });

  it("attempts every simultaneous page and reports aggregate failure when any required delivery fails", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pageWorkerHeartbeat({
      workerId: "w-compound-failure",
      ok: false,
      stale: true,
      expiredLeases: 1,
      deadLetter: 1,
      releaseDispatchDegraded: true,
      releaseDispatchFailureStage: "claim",
      releaseDispatchFailureCode: "release_dispatch_claim_unavailable",
    });
    if (!result || result.skipped) throw new Error("expected aggregate delivery result");
    expect(result.ok).toBe(false);
    expect(result.deliveries).toHaveLength(4);
    expect(result.deliveries.map((delivery) => delivery.ok)).toEqual([true, false, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("pages when the readiness probe is failing (the real /ready path)", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pageReadiness({
      status: "fail",
      checks: [
        { name: "env", ok: true },
        { name: "db_ping", ok: false },
      ],
    });
    if (!res || res.skipped) throw new Error("expected a delivered page");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.type).toBe("readiness_fail");
  });

  it("does not page when the readiness probe is ok", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await pageReadiness({ status: "ok", checks: [{ name: "env", ok: true }] });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the sink rejects, so the observed path is not aborted", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Both wrappers resolve (never reject) on transport failure. This is what
    // lets emitHeartbeat / the /ready handler fire them fire-and-forget without
    // a paging outage interrupting the heartbeat write or the probe response.
    const heartbeat = await pageWorkerHeartbeat({ workerId: "w1", ok: false, stale: true });
    if (!heartbeat || heartbeat.skipped) throw new Error("expected a delivery attempt");
    expect(heartbeat.ok).toBe(false);

    const readiness = await pageReadiness({
      status: "fail",
      checks: [{ name: "db_ping", ok: false }],
    });
    if (!readiness || readiness.skipped) throw new Error("expected a delivery attempt");
    expect(readiness.ok).toBe(false);
  });
});

describe("pagingEventForEgressReceipt", () => {
  const HOUR = 60 * 60 * 1000;

  it("surfaces a critical page BEFORE expiry once inside the lead window", () => {
    // now is strictly before expiry, but within the lead window: this is the
    // "surfaced before expiry rather than after" control. Delete the lead-window
    // comparison (return null unconditionally, or only page once expired) and
    // this assertion dies.
    const event = pagingEventForEgressReceipt({
      expiresAt: "2026-08-21T12:00:00.000Z",
      now: "2026-08-21T11:30:00.000Z", // 30 min before expiry
      leadMs: HOUR, // 60 min lead
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("egress_receipt_expiring");
    expect(event?.severity).toBe("critical");
    expect(event?.details).toMatchObject({ lapsed: false });
    expect(event?.summary).toContain("expires in");
  });

  it("stays silent while the receipt still has healthy margin", () => {
    const event = pagingEventForEgressReceipt({
      expiresAt: "2026-08-21T12:00:00.000Z",
      now: "2026-08-21T08:00:00.000Z", // 4h before expiry
      leadMs: HOUR,
    });
    expect(event).toBeNull();
  });

  it("still fires (fails closed) once the receipt has already lapsed", () => {
    const event = pagingEventForEgressReceipt({
      expiresAt: "2026-08-21T12:00:00.000Z",
      now: "2026-08-21T13:00:00.000Z", // 1h after expiry
      leadMs: HOUR,
    });
    expect(event).not.toBeNull();
    expect(event?.details).toMatchObject({ lapsed: true });
    expect(event?.summary).toContain("lapsed");
  });

  it("treats an unreadable expiry as a critical alarm, never as fresh", () => {
    const event = pagingEventForEgressReceipt({
      expiresAt: "not-a-timestamp",
      now: "2026-08-21T13:00:00.000Z",
      leadMs: HOUR,
    });
    expect(event).not.toBeNull();
    expect(event?.severity).toBe("critical");
    expect(event?.summary).toContain("unreadable");
  });

  it("pageEgressReceiptFreshness pages before expiry and no-ops when healthy", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const healthy = await pageEgressReceiptFreshness({
      expiresAt: "2026-08-21T12:00:00.000Z",
      now: "2026-08-21T08:00:00.000Z",
      leadMs: HOUR,
    });
    expect(healthy).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const approaching = await pageEgressReceiptFreshness({
      expiresAt: "2026-08-21T12:00:00.000Z",
      now: "2026-08-21T11:30:00.000Z",
      leadMs: HOUR,
    });
    if (!approaching || approaching.skipped) throw new Error("expected a delivery attempt");
    expect(approaching.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pageEgressReceiptRenewalFailed", () => {
  it("pages critical on a failed renewal run", async () => {
    process.env.PAGING_WEBHOOK_URL = "https://ops.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pageEgressReceiptRenewalFailed({
      runUrl: "https://github.test/run/1",
      detail: "mint step failed",
    });
    if (result.skipped) throw new Error("expected a delivery attempt");
    expect(result.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe("egress_receipt_renewal_failed");
    expect(body.severity).toBe("critical");
  });
});
