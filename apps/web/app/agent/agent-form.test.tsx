import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentForm, buildWardenRequest } from "./agent-form.js";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("Warden intake form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only provider and repository references in customer mode", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        customerMode
        consumers={[{
          id: "consumer-a",
          name: "Canary repository",
          providers: [{ slug: "stripe", name: "Stripe" }],
        }]}
      />,
    );

    expect(html).toContain("Approved provider");
    expect(html).toContain("Canary repository");
    expect(html).toContain("Start bounded pilot");
    expect(html).not.toContain("Files Fettler may change");
    expect(html).not.toContain("Error log");
    expect(html).not.toContain("Goal");
  });

  it("builds a reference only customer request", () => {
    expect(buildWardenRequest({
      customerMode: true,
      providerSlug: "stripe",
      consumerId: "consumer-a",
      goal: "ignored",
      allowedPaths: "src/private.ts",
      errorLog: "ignored",
    })).toEqual({
      endpoint: "/fettler/pilot",
      body: { providerSlug: "stripe", consumerId: "consumer-a" },
    });
  });

  it("retains the bounded raw form only for demo mode", () => {
    const request = buildWardenRequest({
      customerMode: false,
      providerSlug: "",
      consumerId: "consumer-a",
      goal: "Fix the API path",
      allowedPaths: "src/client.ts\nsrc/types.ts",
      errorLog: "404",
    });
    expect(request).toEqual({
      endpoint: "/agent/runs",
      body: {
        goal: "Fix the API path",
        consumerId: "consumer-a",
        allowedChangedPaths: ["src/client.ts", "src/types.ts"],
        errorLog: "404",
        maxSteps: 20,
        async: true,
      },
    });
  });
});
