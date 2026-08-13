import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Route apiGet by path: the onboarding status when the guided flow asks for it,
// otherwise the minimal shapes the operator install page reads.
vi.mock("../../lib/api", () => ({
  apiGet: vi.fn(async (path: string) => {
    if (path === "/self-serve/onboarding") {
      return {
        tenantId: "tenant-a",
        workspaceName: "Acme",
        plan: "free",
        completedSteps: 1,
        totalSteps: 5,
        steps: [
          {
            id: "workspace",
            title: "Create your workspace",
            summary: "Your tenant.",
            why: "Isolation.",
            state: "done",
            detail: "Workspace Acme is on the free plan.",
            blockedReason: null,
            action: { kind: "none", label: "", href: null },
            meta: null,
          },
          {
            id: "connect",
            title: "Connect a repository",
            summary: "Link your repo.",
            why: "Real code.",
            state: "next",
            detail: "No repository connected yet.",
            blockedReason: null,
            action: { kind: "connect", label: "Connect repository", href: null },
            meta: null,
          },
        ],
      };
    }
    if (path === "/pilot-success-contracts") return { data: [] };
    if (path === "/platform/scm") return {};
    return [];
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const FLAGS = [
  "MENDPOINT_SELF_SERVE_SIGNUP",
  "MENDPOINT_SELF_SERVE_CONNECT",
  "MENDPOINT_SELF_SERVE_WARDEN",
] as const;
const original = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));

function setFlags(on: boolean): void {
  for (const flag of FLAGS) {
    if (on) process.env[flag] = "1";
    else delete process.env[flag];
  }
}

async function renderInstall(): Promise<string> {
  vi.resetModules();
  const { default: InstallPage } = await import("./page.js");
  return renderToStaticMarkup(await InstallPage());
}

afterEach(() => {
  for (const flag of FLAGS) {
    if (original[flag] === undefined) delete process.env[flag];
    else process.env[flag] = original[flag]!;
  }
});

describe("install page self-serve onboarding gate", () => {
  it("keeps the operator install page unchanged when the self-serve stack is off", async () => {
    setFlags(false);
    const html = await renderInstall();
    // The operator wizard + evidence checklist remain the first-run surface.
    expect(html).toContain("Install Mendpoint");
    expect(html).toContain("Pilot readiness checklist");
    // The guided flow does not leak into the operator page.
    expect(html).not.toContain("Get started with Mendpoint");
  });

  it("does not enable the guided flow when only some flags are set", async () => {
    setFlags(false);
    process.env.MENDPOINT_SELF_SERVE_SIGNUP = "1";
    process.env.MENDPOINT_SELF_SERVE_CONNECT = "1";
    // Warden flag intentionally left off.
    const html = await renderInstall();
    expect(html).toContain("Pilot readiness checklist");
    expect(html).not.toContain("Get started with Mendpoint");
  });

  it("replaces the checklist with the guided onboarding when the full stack is on", async () => {
    setFlags(true);
    const html = await renderInstall();
    expect(html).toContain("Get started with Mendpoint");
    expect(html).toContain("Connect a repository");
    // The operator evidence checklist is not the self-serve entry point.
    expect(html).not.toContain("Pilot readiness checklist");
  });
});
