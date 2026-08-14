import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndex, type SdkDetectionContext } from "./index.js";
import {
  classifyField,
  classifyMemberChain,
  providerBindingsForFile,
  resolveSdkContext,
} from "./sdk-detect.js";

/** The regex that used to ship: receiver / method names lifted from our fixtures. */
const LEGACY_SDK_RE =
  /\b((?:client|acme|stripe|api|sdk)\.[\w.]+|(?:charges|customers|paymentIntents)\.[\w]+)\b/g;

const tmpDirs: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sdk-detect-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  if (!files["package.json"]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const twilioCtx: SdkDetectionContext = {
  receivers: ["twilio", "messages"],
  methodPaths: [],
  methods: [],
  fields: ["body", "content"],
  importHints: ["twilio"],
};

describe("classifyMemberChain", () => {
  const sets = resolveSdkContext(twilioCtx);
  const noReceivers = new Set<string>();

  it("labels a known-provider chain provider_surface", () => {
    expect(classifyMemberChain("twilio.messages.create", sets, noReceivers)).toBe(
      "provider_surface",
    );
  });

  it("labels an unknown chain general_heuristic (never silent)", () => {
    expect(classifyMemberChain("mailer.queue.push", sets, noReceivers)).toBe("general_heuristic");
  });

  it("drops language-builtin noise from the fallback", () => {
    expect(classifyMemberChain("console.log", sets, noReceivers)).toBeNull();
    expect(classifyMemberChain("JSON.stringify", sets, noReceivers)).toBeNull();
  });

  it("with no provider context every chain is general_heuristic, not silent", () => {
    const empty = resolveSdkContext();
    expect(empty.hasProvider).toBe(false);
    expect(classifyMemberChain("plaid.accounts.get", empty, noReceivers)).toBe("general_heuristic");
  });
});

describe("providerBindingsForFile (import resolution)", () => {
  it("resolves aliased named imports from the provider package", () => {
    const text = 'import { Client as sms } from "twilio";\nsms.messages.create({});\n';
    const bindings = providerBindingsForFile(text, "typescript", ["twilio"]);
    expect(bindings.has("sms")).toBe(true);
  });

  it("ignores imports from unrelated packages", () => {
    const text = 'import { Client as sms } from "nodemailer";\n';
    const bindings = providerBindingsForFile(text, "typescript", ["twilio"]);
    expect(bindings.size).toBe(0);
  });

  it("resolves python from-imports", () => {
    const bindings = providerBindingsForFile("from plaid import ApiClient as pc\n", "python", [
      "plaid",
    ]);
    expect(bindings.has("pc")).toBe(true);
  });
});

describe("classifyField", () => {
  it("matches spec fields regardless of the old hardcoded names", () => {
    const sets = resolveSdkContext({
      receivers: [],
      methodPaths: [],
      methods: [],
      fields: ["account_id", "routing_number"],
      importHints: [],
    });
    expect(classifyField("account_id", sets)).toBe("provider_surface");
    // A name from the old hardcoded list is NOT a provider match when it is not in the spec.
    expect(classifyField("amount", sets)).toBeNull();
  });

  it("falls back to a structural heuristic only when no spec fields are known", () => {
    const empty = resolveSdkContext();
    expect(classifyField("starting_after", empty)).toBe("general_heuristic");
    expect(classifyField("id", empty)).toBeNull();
  });
});

describe("buildIndex SDK detection is provider-driven", () => {
  const twilioSrc = [
    'import twilio from "twilio";',
    "export async function notify(to: string) {",
    '  return twilio.messages.create({ to, Body: "hi" });',
    "}",
  ].join("\n");

  it("detects a novel provider's SDK calls the legacy regex missed (zero today)", () => {
    // Prove the regression: the old regex finds nothing in this source.
    expect(twilioSrc.match(LEGACY_SDK_RE)).toBeNull();

    const dir = makeRepo({ "src/sms.ts": twilioSrc });
    const withCtx = buildIndex(dir, { sdkContext: twilioCtx });
    const providerCalls = withCtx.apiUsages.filter(
      (u) => u.kind === "sdk_call" && u.detection === "provider_surface",
    );
    expect(providerCalls.some((u) => u.value === "twilio.messages.create")).toBe(true);
  });

  it("uses import resolution for an aliased receiver name", () => {
    const dir = makeRepo({
      "src/sms.ts": [
        'import { Client as sms } from "twilio";',
        "export function send() {",
        '  return sms.messages.create({ Body: "x" });',
        "}",
      ].join("\n"),
    });
    // Receivers deliberately omit "sms"; only import resolution can catch it.
    const ctx: SdkDetectionContext = { ...twilioCtx, receivers: ["twilio"] };
    const index = buildIndex(dir, { sdkContext: ctx });
    const providerCalls = index.apiUsages.filter(
      (u) => u.kind === "sdk_call" && u.detection === "provider_surface",
    );
    expect(providerCalls.some((u) => u.value === "sms.messages.create")).toBe(true);
  });

  it("without provider context still emits sdk_call usages, all general_heuristic", () => {
    const dir = makeRepo({ "src/sms.ts": twilioSrc });
    const index = buildIndex(dir);
    const sdkCalls = index.apiUsages.filter((u) => u.kind === "sdk_call");
    expect(sdkCalls.length).toBeGreaterThan(0); // never silently empty
    expect(sdkCalls.every((u) => u.detection === "general_heuristic")).toBe(true);
    expect(sdkCalls.some((u) => u.detection === "provider_surface")).toBe(false);
  });

  it("still recognizes the acme/stripe fixture receivers (no regression)", () => {
    const dir = makeRepo({
      "src/pay.ts": [
        "export function pay(client: any, stripe: any) {",
        "  client.charges.create({ amount_cents: 100 });",
        "  stripe.customers.list();",
        "}",
      ].join("\n"),
    });
    const ctx: SdkDetectionContext = {
      receivers: ["stripe", "charges", "customers", "client"],
      methodPaths: ["charges.create", "customers.list"],
      methods: ["create", "list"],
      fields: ["amount_cents"],
      importHints: ["stripe"],
    };
    const index = buildIndex(dir, { sdkContext: ctx });
    const provider = index.apiUsages.filter(
      (u) => u.kind === "sdk_call" && u.detection === "provider_surface",
    );
    expect(provider.some((u) => u.value.includes("charges.create"))).toBe(true);
    expect(provider.some((u) => u.value.includes("customers.list"))).toBe(true);
  });
});
