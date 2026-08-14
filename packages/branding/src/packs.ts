/**
 * First-party branded agent packaging — provider-native skins over the neutral Mendpoint core.
 * Example: "Install Stripe's Update Agent" vs generic Mendpoint.
 */
export type BrandedAgentPack = {
  /** Unique pack id */
  id: string;
  /** Provider slug this pack wraps */
  providerSlug: string;
  /** Customer-facing agent name */
  displayName: string;
  /** Short tagline for install UI */
  tagline: string;
  /** Brand accent (CSS color) */
  accentColor: string;
  /** PR title prefix, e.g. "[Stripe Update Agent]" */
  prTitlePrefix: string;
  /** Footer lines appended to every migration PR body */
  prFooterLines: string[];
  /** Docs URL for the branded agent */
  docsUrl?: string;
  /** Optional install CTA copy */
  installCta: string;
  /** Labels applied on generated PRs */
  labels: string[];
  /** Whether this pack is available on free plan */
  requiresPlan: "free" | "pro" | "enterprise";
};

/** Neutral product footer for pipeline / migration PRs (no first-party brand pack). */
export const WARDEN_PR_FOOTER = [
  "---",
  "_Opened by **Fettler** (Mendpoint). Graph-leaned API impact · human review required · never auto-merged by default._",
].join("\n");

const WARDEN_MENPOINT_LINE =
  "_Powered by **Fettler** / Mendpoint. Human review required · never auto-merged by default._";

/**
 * Ensure a PR body carries Fettler / Mendpoint attribution.
 * - No attribution → full WARDEN_PR_FOOTER
 * - Mendpoint only (typical brand pack) → short Fettler/Mendpoint line
 * - Already mentions Fettler → unchanged
 */
export function ensureWardenFooter(body: string): string {
  const renamedBody = body.replace(/\bWarden\b/g, "Fettler");
  if (/\bFettler\b/i.test(renamedBody)) return renamedBody;
  if (/\bMendpoint\b/i.test(renamedBody)) {
    return `${renamedBody.trimEnd()}\n\n${WARDEN_MENPOINT_LINE}`;
  }
  return `${renamedBody.trimEnd()}\n\n${WARDEN_PR_FOOTER}`;
}

export const BRAND_PACKS: BrandedAgentPack[] = [
  {
    id: "stripe-update-agent",
    providerSlug: "stripe",
    displayName: "Stripe Update Agent",
    tagline: "Stripe-native Mendpoint for your integration surface",
    accentColor: "#635BFF",
    prTitlePrefix: "[Stripe Update Agent]",
    prFooterLines: [
      "---",
      "_Opened by the **Stripe Update Agent** (powered by Mendpoint)._",
      "_Review carefully — never auto-merged._",
      "Docs: https://stripe.com/docs/upgrades",
    ],
    docsUrl: "https://stripe.com/docs/upgrades",
    installCta: "Install Stripe's Update Agent",
    labels: ["stripe-update-agent", "mendpoint", "api-migration"],
    requiresPlan: "pro",
  },
  {
    id: "openai-compat-agent",
    providerSlug: "openai",
    displayName: "OpenAI Compat Agent",
    tagline: "Keep chat completions and SDK calls current",
    accentColor: "#10A37F",
    prTitlePrefix: "[OpenAI Compat Agent]",
    prFooterLines: [
      "---",
      "_Opened by the **OpenAI Compat Agent** (powered by Mendpoint)._",
      "_Human review required._",
    ],
    docsUrl: "https://platform.openai.com/docs/changelog",
    installCta: "Install OpenAI Compat Agent",
    labels: ["openai-compat-agent", "mendpoint", "api-migration"],
    requiresPlan: "pro",
  },
  {
    id: "acme-payments-agent",
    providerSlug: "acme-payments",
    displayName: "Acme Payments Agent",
    tagline: "Demo first-party packaging for Acme Payments",
    accentColor: "#34d399",
    prTitlePrefix: "[Acme Payments Agent]",
    prFooterLines: [
      "---",
      "_Opened by the **Acme Payments Agent** (powered by Mendpoint)._",
      "_Fixture brand pack for demos._",
    ],
    docsUrl: "https://acme-payments.example/docs",
    installCta: "Install Acme Payments Agent",
    labels: ["acme-payments-agent", "mendpoint"],
    requiresPlan: "free",
  },
  {
    id: "github-api-agent",
    providerSlug: "github",
    displayName: "GitHub API Agent",
    tagline: "Stay current with REST/Octokit surface changes",
    accentColor: "#238636",
    prTitlePrefix: "[GitHub API Agent]",
    prFooterLines: [
      "---",
      "_Opened by the **GitHub API Agent** (powered by Mendpoint)._",
    ],
    docsUrl: "https://docs.github.com/en/rest",
    installCta: "Install GitHub API Agent",
    labels: ["github-api-agent", "mendpoint"],
    requiresPlan: "enterprise",
  },
];

export function listBrandPacks(): BrandedAgentPack[] {
  return BRAND_PACKS;
}

export function getBrandPack(id: string): BrandedAgentPack | undefined {
  return BRAND_PACKS.find((p) => p.id === id);
}

export function getBrandPackForProvider(providerSlug: string): BrandedAgentPack | undefined {
  return BRAND_PACKS.find((p) => p.providerSlug === providerSlug);
}

/** Apply brand packaging to a generated PR title/body. Always ensures Fettler attribution. */
export function applyBrandPack(
  pack: BrandedAgentPack,
  draft: { title: string; body: string },
): { title: string; body: string; labels: string[] } {
  const title = draft.title.startsWith(pack.prTitlePrefix)
    ? draft.title
    : `${pack.prTitlePrefix} ${draft.title}`;
  const footer = pack.prFooterLines.join("\n");
  const withPack = draft.body.includes(pack.displayName)
    ? draft.body
    : `${draft.body}\n\n${footer}`;
  const body = ensureWardenFooter(withPack);
  return { title, body, labels: [...pack.labels] };
}
