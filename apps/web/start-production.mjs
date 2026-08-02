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
  const oidcIssuer = env.OIDC_ISSUER?.trim();
  const oidcAudience = env.OIDC_AUDIENCE?.trim();
  const oidcJwks = env.OIDC_JWKS_URI?.trim();
  const oidcClientId = env.OIDC_CLIENT_ID?.trim();
  const oidcRedirectUri = env.OIDC_REDIRECT_URI?.trim();
  const anyOidc = Boolean(
    oidcIssuer || oidcAudience || oidcJwks || oidcClientId || oidcRedirectUri,
  );
  const customerReady = env.MENDPOINT_CUSTOMER_READY === "1";

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
  if (anyOidc) {
    if (!oidcIssuer) errors.push("OIDC_ISSUER is required for browser identity");
    if (!oidcAudience) errors.push("OIDC_AUDIENCE is required for browser identity");
    if (!oidcJwks) errors.push("OIDC_JWKS_URI is required for browser identity");
    if (!oidcClientId) errors.push("OIDC_CLIENT_ID is required for browser identity");
    if (!oidcRedirectUri) errors.push("OIDC_REDIRECT_URI is required for browser identity");
    for (const [name, value] of [
      ["OIDC_ISSUER", oidcIssuer],
      ["OIDC_JWKS_URI", oidcJwks],
      ["OIDC_REDIRECT_URI", oidcRedirectUri],
    ]) {
      if (!value) continue;
      try {
        if (new URL(value).protocol !== "https:") errors.push(`${name} must use https`);
      } catch {
        errors.push(`${name} must be a valid URL`);
      }
    }
  }
  if (customerReady) {
    if (!anyOidc) errors.push("Customer ready mode requires browser OIDC");
    if (env.GITHUB_MODE?.trim() !== "real") {
      errors.push("Customer ready mode requires GITHUB_MODE=real");
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
