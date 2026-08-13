import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyCapabilityAdoptionOpportunity } from "./index.js";

afterEach(() => {
  delete process.env.SLACK_WEBHOOK_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const alert = {
  provider: "acme-payments",
  capability: "POST /v1/payment_links",
  endpoint: "POST /v1/payment_links",
  adoptingConsumers: ["billing-app"],
  nonAdoptingConsumers: ["shop-app", "invoicing-app"],
  suggestedAction: 'Generate an adopt-PR (pipeline mode "adopt") for POST /v1/payment_links.',
  priority: 2,
};

describe("notifyCapabilityAdoptionOpportunity", () => {
  it("skips when SLACK_WEBHOOK_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await notifyCapabilityAdoptionOpportunity(alert);
    expect(res).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a payload carrying provider, capability, and consumer split", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T/B/X";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const res = await notifyCapabilityAdoptionOpportunity(alert);
    expect(res).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.text).toContain("Capability adoption opportunity");
    expect(body.text).toContain("acme-payments");
    expect(body.text).toContain("POST /v1/payment_links");
    expect(body.text).toContain("shop-app, invoicing-app");
    expect(body.text).toContain("billing-app");
    expect(body.text).toContain("adopt-PR");
  });
});
