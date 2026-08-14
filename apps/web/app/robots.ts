import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/docs", "/docs/", "/security", "/service-status", "/privacy", "/terms", "/design-partners"],
        disallow: ["/console", "/api"],
      },
    ],
    sitemap: "https://www.mendpoint.ai/sitemap.xml",
  };
}
