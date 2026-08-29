import type { Metadata } from "next";
import { apiGet, type ChangeImpactCoverage, type Provider } from "../../../lib/api";
import { changeImpactCoverageSummary } from "../../components/console/change-impact-coverage";
import { ChangesView } from "../../components/console/changes-view";
import type { CoverageSummary } from "../../components/console/pr-map";
import type { ChangesData, Severity, SpecChange, Stat } from "../../components/console/fixtures";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Breaking changes" };

type ChangeListItem = {
  id: string;
  providerId: string;
  fromVersionId: string | null;
  toVersionId: string | null;
  risk: string;
  summary: string;
  severity: string;
  diffJson: string;
  createdAt: string;
};

type DiffEntry = {
  op: string;
  path?: string;
  method?: string;
  field?: string;
  fromField?: string;
  toField?: string;
  detail?: string;
  breaking: boolean;
};

type Finding = {
  id: string;
  consumerId: string;
  filePath: string;
  lineStart: number;
  symbol: string;
  confidence: string;
};

type ChangeDetail = ChangeListItem & {
  diff: { entries: DiffEntry[]; risk: string; summary: string };
  findings: Finding[];
  prs: Array<{ id: string; status: string }>;
  impactCoverage?: ChangeImpactCoverage;
};

type ProviderDetail = Provider & {
  versions: Array<{ id: string; versionLabel: string }>;
};

const ADDITIVE_OPS = new Set(["path_added", "method_added", "response_field_added"]);

function severityFor(entry: DiffEntry): Severity {
  if (entry.breaking) return "breaking";
  if (ADDITIVE_OPS.has(entry.op)) return "safe";
  return "deprecated";
}

function endpointFor(entry: DiffEntry): string {
  const method = entry.method ? `${entry.method.toUpperCase()} ` : "";
  if (entry.path) return `${method}${entry.path}`.trim();
  if (entry.field) return entry.field;
  if (entry.fromField) return entry.fromField;
  return entry.op;
}

function noteFor(entry: DiffEntry): string {
  if (entry.fromField && entry.toField) return `${entry.fromField} → ${entry.toField}`;
  return entry.detail ?? entry.field ?? entry.op;
}

/**
 * Findings are recorded at change scope, not keyed to individual diff entries,
 * so we attribute a call site to an entry by matching its resolved symbol / file
 * path against the tokens the entry contributes (field renames, method, path
 * segments). This is the nearest available signal; additive entries legitimately
 * match nothing (there is no call site to fix).
 */
function entryTokens(entry: DiffEntry): string[] {
  const tokens: string[] = [];
  if (entry.fromField) tokens.push(entry.fromField);
  if (entry.toField) tokens.push(entry.toField);
  if (entry.field) tokens.push(entry.field);
  if (entry.method) tokens.push(entry.method);
  if (entry.path) {
    tokens.push(entry.path, ...entry.path.split("/").filter(Boolean));
  }
  return tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 1);
}

function matchFindings(entry: DiffEntry, findings: Finding[]): Finding[] {
  const tokens = entryTokens(entry);
  if (tokens.length === 0) return [];
  return findings.filter((f) => {
    const symbol = (f.symbol ?? "").toLowerCase();
    const filePath = (f.filePath ?? "").toLowerCase();
    return tokens.some(
      (tok) =>
        (symbol.length > 1 && (symbol.includes(tok) || tok.includes(symbol))) ||
        filePath.includes(tok),
    );
  });
}

function versionLabel(
  provider: ProviderDetail | null,
  versionId: string | null,
): string | null {
  if (!versionId) return null;
  const match = provider?.versions.find((v) => v.id === versionId);
  return match?.versionLabel ?? null;
}

function buildTarget(
  change: ChangeListItem,
  provider: Provider | null,
  detail: ProviderDetail | null,
): string {
  const name = provider?.slug ?? provider?.name ?? "provider";
  const from = versionLabel(detail, change.fromVersionId);
  const to = versionLabel(detail, change.toVersionId);
  if (from && to) return `${name} · ${from} → ${to}`;
  if (to) return `${name} · ${to}`;
  return name;
}

export default async function ChangesPage() {
  const [changesResult, providersResult] = await Promise.allSettled([
    apiGet<ChangeListItem[]>("/changes"),
    apiGet<Provider[]>("/providers"),
  ]);

  const changes = changesResult.status === "fulfilled" ? changesResult.value : [];
  const providers = providersResult.status === "fulfilled" ? providersResult.value : [];

  // Prefer the newest breaking change; fall back to the newest change overall.
  const selected =
    changes.find((c) => c.risk === "breaking") ?? changes[0] ?? null;

  let data: ChangesData | null = null;
  let coverage: CoverageSummary | null = null;
  if (selected) {
    const provider = providers.find((p) => p.id === selected.providerId) ?? null;
    const [detailResult, providerDetailResult] = await Promise.allSettled([
      apiGet<ChangeDetail>(`/changes/${selected.id}`),
      provider ? apiGet<ProviderDetail>(`/providers/${provider.slug}`) : Promise.resolve(null),
    ]);

    // A rejected change-detail fetch is an unknown, not an empty diff. Falling
    // through with `detail = null` would build a non-null ChangesData with
    // `changes: []`, which ChangesView renders as "No structural change is
    // staged yet" — certifying a failed fetch as a clean, zero-impact result.
    // Only map the view when the detail fetch actually resolved; otherwise leave
    // `data` null so the honest "Changes unavailable" state renders (mirroring
    // the `/changes` list handling above).
    if (detailResult.status === "fulfilled") {
      const detail = detailResult.value;
      const providerDetail =
        providerDetailResult.status === "fulfilled" ? providerDetailResult.value : null;

      const entries = detail.diff.entries ?? [];
      const findings = detail.findings ?? [];
      const prs = detail.prs ?? [];

      const breakingCount = entries.filter((e) => e.breaking).length;
      const reposAffected = new Set(findings.map((f) => f.consumerId)).size;

      const stats: Stat[] = [
        { label: "Breaking changes", value: String(breakingCount), tone: "amber" },
        { label: "Repositories affected", value: String(reposAffected), tone: "cyan" },
        { label: "Call sites resolved", value: String(findings.length), tone: "cyan" },
        { label: "PRs staged", value: String(prs.length), tone: "indigo" },
      ];

      const specChanges: SpecChange[] = entries.map((entry) => {
        const matched = matchFindings(entry, findings);
        return {
          severity: severityFor(entry),
          endpoint: endpointFor(entry),
          note: noteFor(entry),
          repos: new Set(matched.map((f) => f.consumerId)).size,
          calls: matched.length,
        };
      });

      data = {
        target: buildTarget(selected, provider, providerDetail),
        stats,
        changes: specChanges,
      };
      // Always derive standing from the channel (or its absence). Dropping
      // impactCoverage here is the FET-017 collapse: empty findings then read
      // as "0 repos · 0 calls" with no "I do not know" state.
      coverage = changeImpactCoverageSummary(detail.impactCoverage);
    }
  }

  return <ChangesView data={data} coverage={coverage} />;
}
