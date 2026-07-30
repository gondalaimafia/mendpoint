import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateWebProductionEnv(env = process.env) {
  const errors = [];
  const apiUrl = env.MENDPOINT_API_URL?.trim();
  const apiKey = env.MENDPOINT_API_KEY?.trim();
  const accessToken = env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  const origins = (
    env.MENDPOINT_WEB_ALLOWED_ORIGINS ??
    env.WEB_URL ??
    ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!apiUrl) {
    errors.push("MENDPOINT_API_URL is required");
  } else {
    try {
      const parsed = new URL(apiUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("MENDPOINT_API_URL must use http or https");
      }
    } catch {
      errors.push("MENDPOINT_API_URL must be a valid URL");
    }
  }
  if (!apiKey) errors.push("MENDPOINT_API_KEY is required");
  if (!accessToken) errors.push("MENDPOINT_WEB_ACCESS_TOKEN is required");
  if (apiKey && accessToken && apiKey === accessToken) {
    errors.push("MENDPOINT_WEB_ACCESS_TOKEN must differ from MENDPOINT_API_KEY");
  }
  if (!origins.length) {
    errors.push("MENDPOINT_WEB_ALLOWED_ORIGINS or WEB_URL is required");
  }
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.origin !== origin
      ) {
        errors.push(`Invalid web origin: ${origin}`);
      }
    } catch {
      errors.push(`Invalid web origin: ${origin}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function isMain() {
  return Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const report = validateWebProductionEnv();
  if (!report.ok) {
    console.error("[mendpoint] web production configuration failed:");
    for (const error of report.errors) console.error("  ", error);
    process.exit(1);
  }
  await import("./apps/web/server.js");
}
