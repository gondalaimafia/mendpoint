import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = /^[1-9][0-9]*$/;
const PERMISSION_LOCATION = "https://api.fly.io/v1";
const SCHEMES = new Set(["flyv1", "bearer"]);

function fail(code) {
  throw new Error(code);
}

function containsAppCaveat(value) {
  if (Array.isArray(value)) return value.some(containsAppCaveat);
  if (value === null || typeof value !== "object") return false;
  if (value.type === "Apps") return true;
  return Object.values(value).some(containsAppCaveat);
}

function isCanonicalStandardBase64(value) {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

export function verifyPureFlyMacaroonCredential(rawValue) {
  const rawCredential = rawValue?.trim() ?? "";
  if (rawCredential.length === 0 || rawCredential.includes(",")) {
    fail("customer_backup_fly_credential_not_pure_macaroon");
  }
  const components = rawCredential.split(/\s+/);
  while (components.length > 1 && SCHEMES.has(components[0].toLowerCase())) {
    components.shift();
  }
  if (components.length !== 1 || !components[0].startsWith("fm2_")) {
    fail("customer_backup_fly_credential_not_pure_macaroon");
  }
  if (!isCanonicalStandardBase64(components[0].slice(4))) {
    fail("customer_backup_fly_credential_not_pure_macaroon");
  }
}

export function verifyFlyAppTokenScope(input) {
  verifyPureFlyMacaroonCredential(input.rawCredential);

  const expectedAppId = input.expectedAppId?.trim() ?? "";
  if (!APP_ID.test(expectedAppId)) {
    fail("customer_backup_token_not_app_scoped");
  }

  let decoded;
  try {
    decoded = JSON.parse(input.debugJson ?? "null");
  } catch {
    fail("customer_backup_token_not_app_scoped");
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    fail("customer_backup_token_not_app_scoped");
  }

  const [permission] = decoded;
  if (
    permission === null ||
    typeof permission !== "object" ||
    permission.location !== PERMISSION_LOCATION ||
    !Array.isArray(permission.caveats)
  ) {
    fail("customer_backup_token_not_app_scoped");
  }

  const appCaveats = permission.caveats.filter((caveat) =>
    caveat !== null && typeof caveat === "object" && caveat.type === "Apps"
  );
  if (appCaveats.length !== 1) {
    fail("customer_backup_token_not_app_scoped");
  }
  const nonAppCaveats = permission.caveats.filter((caveat) => caveat !== appCaveats[0]);
  if (containsAppCaveat(nonAppCaveats)) {
    fail("customer_backup_token_not_app_scoped");
  }

  const apps = appCaveats[0].body?.apps;
  if (apps === null || typeof apps !== "object" || Array.isArray(apps)) {
    fail("customer_backup_token_not_app_scoped");
  }
  const appIds = Object.keys(apps);
  if (
    appIds.length !== 1 ||
    appIds[0] !== expectedAppId ||
    !APP_ID.test(appIds[0]) ||
    typeof apps[appIds[0]] !== "string" ||
    apps[appIds[0]].trim().length === 0
  ) {
    fail("customer_backup_token_not_app_scoped");
  }
}

function main() {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--credential-only") {
      verifyPureFlyMacaroonCredential(process.env.FLY_API_TOKEN);
    } else if (process.argv.length === 2) {
      verifyFlyAppTokenScope({
        rawCredential: process.env.FLY_API_TOKEN,
        debugJson: process.env.MENDPOINT_FLY_TOKEN_DEBUG_JSON,
        expectedAppId: process.env.MENDPOINT_EXPECTED_FLY_APP_ID,
      });
    } else {
      fail("customer_backup_token_not_app_scoped");
    }
  } catch (error) {
    const code = error instanceof Error && (
      error.message === "customer_backup_fly_credential_not_pure_macaroon" ||
      error.message === "customer_backup_token_not_app_scoped"
    ) ? error.message : "customer_backup_token_not_app_scoped";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
