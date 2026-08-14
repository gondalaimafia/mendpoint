import type { MetadataRoute } from "next";
import { PRODUCT_DOCS } from "./docs/catalog.js";

const paths = ["/", "/docs", ...PRODUCT_DOCS.map((page) => `/docs/${page.slug}`), "/security", "/service-status", "/privacy", "/terms", "/design-partners"];

export default function sitemap(): MetadataRoute.Sitemap {
  return paths.map((path) => ({
    url: `https://www.mendpoint.ai${path}`,
    changeFrequency: path === "/service-status" ? "daily" : "monthly",
    priority: path === "/" ? 1 : 0.6,
  }));
}
