import { findProductDoc, renderProductDocMarkdown } from "../../catalog.js";

export const dynamic = "force-static";

export function generateStaticParams() {
  const { PRODUCT_DOCS } = require("../../catalog.js") as typeof import("../../catalog.js");
  return PRODUCT_DOCS.map((page) => ({ slug: page.slug }));
}

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const page = findProductDoc((await context.params).slug);
  if (!page) return new Response("Documentation page not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  return new Response(renderProductDocMarkdown(page), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
