import type { Metadata } from "next";
import { apiGet, type Provider } from "../../../lib/api";
import { SettingsView } from "../../components/console/settings-view";
import type { SettingsData } from "../../components/console/fixtures";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

type ProviderDetail = Provider & {
  openapiUrl: string | null;
  versions: Array<{ id: string; versionLabel: string }>;
};

type PolicyDefaults = {
  autoMergeLowRisk: boolean;
  notificationsOnly: boolean;
};

export default async function SettingsPage() {
  const [providersResult, policyResult] = await Promise.allSettled([
    apiGet<Array<Provider & { openapiUrl: string | null }>>("/providers"),
    apiGet<PolicyDefaults>("/policies/defaults"),
  ]);

  const providers = providersResult.status === "fulfilled" ? providersResult.value : [];
  const policy = policyResult.status === "fulfilled" ? policyResult.value : null;
  const provider = providers[0] ?? null;

  let detail: ProviderDetail | null = null;
  if (provider) {
    const detailResult = await Promise.allSettled([
      apiGet<ProviderDetail>(`/providers/${provider.slug}`),
    ]);
    detail = detailResult[0].status === "fulfilled" ? detailResult[0].value : null;
  }

  // Newest first: versions are stored oldest-to-newest.
  const versionOptions = (detail?.versions ?? [])
    .map((v) => v.versionLabel)
    .reverse();

  const data: SettingsData = {
    specUrl: detail?.openapiUrl ?? provider?.openapiUrl ?? "",
    targetVersion: versionOptions[0] ?? "",
    versionOptions,
    // PR-policy mapping: no dedicated "open as draft" / "auto-open" flags exist,
    // so map from the real policy defaults (auto-merge off => drafts on;
    // notify-only => not auto-opening PRs, Slack notification on).
    drafts: policy ? !policy.autoMergeLowRisk : true,
    autoOpen: policy ? !policy.notificationsOnly : true,
    notifySlack: policy ? policy.notificationsOnly : false,
  };

  return <SettingsView data={data} />;
}
