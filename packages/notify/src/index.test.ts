import { afterEach, describe, expect, it, vi } from "vitest";
import { notifySlack, notifyWardenEvent } from "./index.js";

afterEach(() => {
  delete process.env.SLACK_WEBHOOK_URL;
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
  });
});

describe("notifyWardenEvent", () => {
  it("formats event and posts when webhook set", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/X";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await notifyWardenEvent("pr_opened", "acme/api#42");
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.text).toContain("PR opened");
    expect(body.text).toContain("acme/api#42");
  });

  it("skips warden event when no webhook", async () => {
    const res = await notifyWardenEvent("warden_finished", "ok");
    expect(res).toEqual({ ok: true, skipped: true });
  });
});
