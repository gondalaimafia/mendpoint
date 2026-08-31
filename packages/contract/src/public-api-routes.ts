export const PUBLIC_DOCS_API_ROUTE_SCHEMA_VERSION = "2026-08-30.v1" as const;

export const PUBLIC_DOCS_API_ROUTES = Object.freeze([
  "GET /advanced-ai/attestations/:attestationId",
  "GET /advanced-ai/learning/status",
  "GET /agent/runs/:id",
  "GET /audit",
  "GET /audit/export",
  "GET /billing/plans",
  "GET /billing/usage",
  "GET /github/app/install-url",
  "GET /graph/agent/mermaid",
  "GET /graph/changes/:id",
  "GET /graph/consumers/:id",
  "GET /health",
  "GET /keys",
  "GET /live",
  "GET /ready",
  "GET /recovery/summary",
  "GET /tenants",
  "GET /transformer/control-plane/campaigns/:campaignId",
  "POST /advanced-ai/attestations",
  "POST /advanced-ai/learning/consents",
  "POST /advanced-ai/learning/consents/:consentId/revoke",
  "POST /advanced-ai/learning/corpora",
  "POST /advanced-ai/post-trained/adapters",
  "POST /advanced-ai/post-trained/adapters/:adapterId/rollback",
  "POST /advanced-ai/post-trained/adapters/:adapterId/route-dry-run",
  "POST /advanced-ai/post-trained/canaries",
  "POST /advanced-ai/post-trained/evaluations",
  "POST /advanced-ai/post-trained/training-jobs",
  "POST /agent/ci-cycles/:id/pause",
  "POST /agent/runs",
  "POST /agent/runs/:id/candidate/review",
  "POST /billing/usage/reservations",
  "POST /billing/usage/reservations/:id/release",
  "POST /billing/usage/reservations/:id/settle",
  "POST /change-sources",
  "POST /feeds/poll",
  "POST /github/app/callback",
  "POST /graph-learn/query",
  "POST /graphql/schemas/:sourceKey/versions",
  "POST /keys",
  "POST /keys/:id/revoke",
  "POST /platform/scm/connections/:id/revoke",
  "POST /platform/scm/repositories",
  "POST /platform/scm/repositories/:id/snapshots",
  "POST /providers/:slug/publish-version",
  "POST /providers/:slug/versions",
  "POST /tenants/memberships",
  "POST /transformer/control-plane/campaigns/:campaignId/review",
  "POST /transformer/missions",
  "POST /webhooks/github",
] as const);

export type PublicDocsApiRoute = (typeof PUBLIC_DOCS_API_ROUTES)[number];

const publicDocsApiRouteSet: ReadonlySet<string> = new Set(PUBLIC_DOCS_API_ROUTES);

export function isPublicDocsApiRoute(value: string): value is PublicDocsApiRoute {
  return publicDocsApiRouteSet.has(normalizeRoute(value));
}

export function assertPublicDocsApiRoute(value: string): asserts value is PublicDocsApiRoute {
  if (!isPublicDocsApiRoute(value)) {
    throw new Error(`public_docs_api_route_unregistered:${normalizeRoute(value)}`);
  }
}

export function assertPublicDocsApiRoutesMounted(
  mountedRoutes: readonly Readonly<{ method: string; path: string }>[] | readonly string[],
): void {
  const mounted = new Set(
    mountedRoutes.map((route) => typeof route === "string"
      ? normalizeRoute(route)
      : normalizeRoute(`${route.method} ${route.path}`)),
  );
  const missing = PUBLIC_DOCS_API_ROUTES.filter((route) => !mounted.has(route));
  if (missing.length > 0) {
    throw new Error(`public_docs_api_routes_not_mounted:${missing.join(",")}`);
  }
}

function normalizeRoute(value: string): string {
  const match = /^\s*([^\s]+)\s+(.+?)\s*$/.exec(value);
  if (!match) return value.trim();
  const method = match[1]!.toUpperCase();
  const rawPath = match[2]!;
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  return `${method} ${path}`;
}
