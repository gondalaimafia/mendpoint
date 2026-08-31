import { describe, expect, it } from "vitest";
import {
  PUBLIC_DOCS_API_ROUTES,
  assertPublicDocsApiRoute,
  assertPublicDocsApiRoutesMounted,
  isPublicDocsApiRoute,
} from "./public-api-routes.js";

describe("public documentation API route contract", () => {
  it("recognizes only versioned public documentation routes", () => {
    expect(isPublicDocsApiRoute("post /agent/runs/ ")).toBe(true);
    expect(isPublicDocsApiRoute("POST /not-a-runtime-route")).toBe(false);
    expect(() => assertPublicDocsApiRoute("POST /not-a-runtime-route")).toThrow(
      "public_docs_api_route_unregistered:POST /not-a-runtime-route",
    );
  });

  it("accepts a mounted route inventory containing the complete contract", () => {
    expect(() => assertPublicDocsApiRoutesMounted([
      ...PUBLIC_DOCS_API_ROUTES.map((route) => {
        const separator = route.indexOf(" ");
        return { method: route.slice(0, separator).toLowerCase(), path: route.slice(separator + 1) };
      }),
      { method: "GET", path: "/internal/health" },
    ])).not.toThrow();
  });

  it("fails closed when a documented interface is not mounted", () => {
    const missing = PUBLIC_DOCS_API_ROUTES[0];
    expect(() => assertPublicDocsApiRoutesMounted(PUBLIC_DOCS_API_ROUTES.slice(1))).toThrow(
      `public_docs_api_routes_not_mounted:${missing}`,
    );
  });
});
