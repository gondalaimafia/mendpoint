import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The settings page fetches providers + policy defaults; return empty/null so it
// renders the base settings view deterministically.
vi.mock("../../../lib/api", () => ({
  apiGet: vi.fn(async () => []),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const originalFlag = process.env.MENDPOINT_SELF_SERVE_WARDEN;

async function renderPage(): Promise<string> {
  // Re-import per-test so the flag read at render time reflects env.
  vi.resetModules();
  const { default: SettingsPage } = await import("./page.js");
  return renderToStaticMarkup(await SettingsPage());
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env.MENDPOINT_SELF_SERVE_WARDEN;
  else process.env.MENDPOINT_SELF_SERVE_WARDEN = originalFlag;
});

describe("settings connections surface", () => {
  it("omits the Connections surface (byte-identical settings) when the flag is off", async () => {
    delete process.env.MENDPOINT_SELF_SERVE_WARDEN;
    const off = await renderPage();
    expect(off).not.toContain("CONNECTIONS");
    expect(off).not.toContain("ADD A CONNECTION");
    // The base settings view still renders.
    expect(off).toContain("Settings");

    // A non-exact flag value must also stay off.
    process.env.MENDPOINT_SELF_SERVE_WARDEN = "true";
    const notExact = await renderPage();
    expect(notExact).toBe(off);
  });

  it("mounts the Connections surface when the flag is on", async () => {
    process.env.MENDPOINT_SELF_SERVE_WARDEN = "1";
    const html = await renderPage();
    expect(html).toContain("CONNECTIONS");
    expect(html).toContain("ADD A CONNECTION");
  });
});
