/**
 * SDK registry signals — complement OpenAPI feeds with package version probes.
 * Offline-safe when URLs fail; supports npm registry JSON.
 */
import { createHash } from "node:crypto";

export type SdkSignal = {
  ecosystem: "npm" | "pypi";
  packageName: string;
  latestVersion?: string;
  contentHash?: string;
  ok: boolean;
  error?: string;
  providerSlug?: string;
};

const NPM_REGISTRY = "https://registry.npmjs.org";

export async function probeNpmPackage(
  packageName: string,
  opts?: { timeoutMs?: number },
): Promise<SdkSignal> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}/latest`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ecosystem: "npm",
        packageName,
        ok: false,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { version?: string };
    const latestVersion = body.version ?? "unknown";
    const contentHash = createHash("sha256")
      .update(`${packageName}@${latestVersion}`)
      .digest("hex")
      .slice(0, 16);
    return { ecosystem: "npm", packageName, latestVersion, contentHash, ok: true };
  } catch (e) {
    return {
      ecosystem: "npm",
      packageName,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

/** Map known SDK packages → vendor slug for feed correlation */
export const SDK_PROVIDER_MAP: Array<{ packageName: string; ecosystem: "npm"; providerSlug: string }> =
  [
    { packageName: "stripe", ecosystem: "npm", providerSlug: "stripe" },
    { packageName: "openai", ecosystem: "npm", providerSlug: "openai" },
    { packageName: "@aws-sdk/client-s3", ecosystem: "npm", providerSlug: "aws-sdk" },
    { packageName: "twilio", ecosystem: "npm", providerSlug: "twilio" },
    { packageName: "@octokit/rest", ecosystem: "npm", providerSlug: "github" },
  ];

export async function probeKnownSdks(opts?: {
  localOnly?: boolean;
  packages?: string[];
}): Promise<SdkSignal[]> {
  if (opts?.localOnly) {
    return SDK_PROVIDER_MAP.map((m) => ({
      ecosystem: "npm" as const,
      packageName: m.packageName,
      providerSlug: m.providerSlug,
      ok: true,
      latestVersion: "local-stub",
      contentHash: createHash("sha256")
        .update(`${m.packageName}@local`)
        .digest("hex")
        .slice(0, 16),
    }));
  }
  const list = opts?.packages
    ? SDK_PROVIDER_MAP.filter((m) => opts.packages!.includes(m.packageName))
    : SDK_PROVIDER_MAP;
  const out: SdkSignal[] = [];
  for (const m of list) {
    const s = await probeNpmPackage(m.packageName);
    out.push({ ...s, providerSlug: m.providerSlug });
  }
  return out;
}
