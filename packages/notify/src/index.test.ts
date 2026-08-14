import { afterEach, describe, expect, it, vi } from "vitest";
import { notifySlack, notifyWardenEvent } from "./index.js";

afterEach(() => {
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.MENDPOINT_NOTIFY_TIMEOUT_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notifySlack", () => {
  it("skips when SLACK_WEBHOOK_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await notifySlack({ text: "hello" });
    expect(res).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs JSON text to webhook when set", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/X";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await notifySlack({ text: "pipeline done" });
    expect(res).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.test/services/T/B/X");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "pipeline done" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("error");
  });

  it("fails closed on transport rejection and noncooperative timeout", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/X";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down")));
    await expect(notifySlack({ text: "pipeline done" })).resolves.toEqual({
      ok: false,
      status: 0,
    });

    process.env.MENDPOINT_NOTIFY_TIMEOUT_MS = "10";
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const started = Date.now();
    await expect(notifySlack({ text: "pipeline done" })).resolves.toEqual({
      ok: false,
      status: 0,
    });
    expect(Date.now() - started).toBeLessThan(250);
  }, 1_000);
});

describe("notifyWardenEvent", () => {
  it("formats event and posts when webhook set", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/X";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await notifyWardenEvent("pr_opened", "acme/api#42");
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.text).toContain("*Fettler*");
    expect(body.text).toContain("PR opened");
    expect(body.text).toContain("acme/api#42");
  });

  it("renders the historical warden_finished event key as Fettler", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/X";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await notifyWardenEvent("warden_finished", "ok");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.text).toContain("Fettler finished");
  });

  it("skips warden event when no webhook", async () => {
    const res = await notifyWardenEvent("warden_finished", "ok");
    expect(res).toEqual({ ok: true, skipped: true });
  });
});
