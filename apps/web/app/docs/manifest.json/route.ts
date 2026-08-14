import { buildDocsManifest } from "../catalog.js";

export const dynamic = "force-static";

export function GET() {
  return Response.json(buildDocsManifest(), { headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
