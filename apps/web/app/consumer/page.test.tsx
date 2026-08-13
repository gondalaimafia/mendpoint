import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The consumer page fetches from the API; return empty sets so it renders the
// empty-state placeholder we care about.
vi.mock("../../lib/api", () => ({
  apiGet: vi.fn(async () => []),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const originalFlag = process.env.MENDPOINT_SELF_SERVE_WARDEN;

async function renderPage(): Promise<string> {
  // Re-import per-test so the flag read at module/render time reflects env.
  vi.resetModules();
  const { default: ConsumerPage } = await import("./page.js");
  return renderToStaticMarkup(await ConsumerPage());
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env.MENDPOINT_SELF_SERVE_WARDEN;
  else process.env.MENDPOINT_SELF_SERVE_WARDEN = originalFlag;
});

describe("consumer console self-serve scan trigger", () => {
  it("keeps the demo placeholder byte-identical when the flag is off", async () => {
    delete process.env.MENDPOINT_SELF_SERVE_WARDEN;
    const html = await renderPage();
    expect(html).toContain("No pending PRs — run <code>npm run demo</code> after seed.");
    expect(html).not.toContain("Scan for impact");
  });

  it("does not enable the trigger for a non-exact flag value", async () => {
    process.env.MENDPOINT_SELF_SERVE_WARDEN = "true";
    const html = await renderPage();
    expect(html).toContain("No pending PRs — run <code>npm run demo</code> after seed.");
    expect(html).not.toContain("Scan for impact");
  });

  it("replaces the placeholder with a Scan for impact trigger when the flag is on", async () => {
    process.env.MENDPOINT_SELF_SERVE_WARDEN = "1";
    const html = await renderPage();
    expect(html).toContain("Scan for impact");
    expect(html).not.toContain("npm run demo");
  });
});
