import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { NextRequest } from "next/server";
import { SignedXml } from "xml-crypto";
import { importJWK, jwtVerify } from "jose";
import { GET as samlStart } from "./start/route.js";
import { POST as samlAcs } from "./acs/route.js";
import { GET as samlConfig } from "./config/route.js";
import { GET as oidcConfig } from "../oidc/config/route.js";
import { GET as sessionStatus } from "../session/route.js";
import {
  __resetSamlReplayGuard,
  bridgeJwks,
  mintBridgeToken,
  samlBridgeConfig,
  samlSpConfig,
  validateSamlResponse,
  type SamlFlow,
} from "../../../lib/saml-auth.js";
import {
  ATTACKER_PRIVATE_KEY_PEM,
  BRIDGE_SIGNING_KEY_PEM,
  IDP_CERT_PEM,
  IDP_PRIVATE_KEY_PEM,
} from "./saml-fixtures.js";

const IDP_ENTITY_ID = "https://idp.example/metadata";
const SP_ENTITY_ID = "https://console.example/saml/metadata";
const ACS_URL = "https://console.example/api/saml/acs";
const SSO_URL = "https://idp.example/sso";
const BRIDGE_ISSUER = "https://console.example/saml/bridge";
const API_AUDIENCE = "mendpoint-api";

const SAML_ENV_KEYS = [
  "SAML_IDP_SSO_URL",
  "SAML_IDP_CERT",
  "SAML_IDP_ENTITY_ID",
  "SAML_SP_ENTITY_ID",
  "SAML_ACS_URL",
  "SAML_TENANT_ATTRIBUTE",
  "SAML_DEFAULT_TENANT_ID",
  "SAML_JWT_ISSUER",
  "SAML_JWT_AUDIENCE",
  "SAML_JWT_SIGNING_KEY",
  "SAML_JWT_KID",
  "SAML_JWT_TENANT_CLAIM",
  "SAML_JWT_AMR",
  "OIDC_ISSUER",
  "OIDC_AUDIENCE",
  "OIDC_CLIENT_ID",
  "OIDC_REDIRECT_URI",
  "MENDPOINT_WEB_ACCESS_TOKEN",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SAML_ENV_KEYS) savedEnv[key] = process.env[key];
  __resetSamlReplayGuard();
});

afterEach(() => {
  for (const key of SAML_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function configureSaml(): void {
  process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-session-secret-value";
  process.env.SAML_IDP_SSO_URL = SSO_URL;
  process.env.SAML_IDP_CERT = IDP_CERT_PEM;
  process.env.SAML_IDP_ENTITY_ID = IDP_ENTITY_ID;
  process.env.SAML_SP_ENTITY_ID = SP_ENTITY_ID;
  process.env.SAML_ACS_URL = ACS_URL;
  process.env.SAML_TENANT_ATTRIBUTE = "tenantId";
  process.env.SAML_JWT_ISSUER = BRIDGE_ISSUER;
  process.env.SAML_JWT_AUDIENCE = API_AUDIENCE;
  process.env.SAML_JWT_SIGNING_KEY = BRIDGE_SIGNING_KEY_PEM;
  process.env.SAML_JWT_KID = "saml-bridge-1";
  process.env.SAML_JWT_TENANT_CLAIM = "tenant_id";
  process.env.SAML_JWT_AMR = "mfa";
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

type ResponseOptions = {
  sign?: boolean;
  signerKey?: string;
  assertionId?: string;
  inResponseTo?: string;
  audience?: string;
  recipient?: string;
  destination?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  nameId?: string;
  tenant?: string | null;
  email?: string;
};

function buildAssertionXml(opts: ResponseOptions): string {
  const assertionId = opts.assertionId ?? "_assertion-default";
  const inResponseTo = opts.inResponseTo ?? "_req-default";
  const audience = opts.audience ?? SP_ENTITY_ID;
  const recipient = opts.recipient ?? ACS_URL;
  const destination = opts.destination ?? ACS_URL;
  const notBefore = opts.notBefore ?? iso(-60_000);
  const notOnOrAfter = opts.notOnOrAfter ?? iso(5 * 60_000);
  const nameId = opts.nameId ?? "user@customer.example";
  const email = opts.email ?? "user@customer.example";
  const tenantAttribute =
    opts.tenant === null
      ? ""
      : `<saml:Attribute Name="tenantId"><saml:AttributeValue>${opts.tenant ?? "tenant-acme"}</saml:AttributeValue></saml:Attribute>`;
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response-1" Version="2.0" IssueInstant="${iso(0)}" Destination="${destination}" InResponseTo="${inResponseTo}"><saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${recipient}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_session-1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${tenantAttribute}<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}

function signAssertion(xml: string, key: string): string {
  const sig = new SignedXml({
    privateKey: key,
    idAttribute: "ID",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, {
    location: {
      reference:
        "/*[local-name(.)='Response']/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: "after",
    },
  });
  return sig.getSignedXml();
}

function makeSamlResponse(opts: ResponseOptions = {}): string {
  const xml = buildAssertionXml(opts);
  const signed = opts.sign === false ? xml : signAssertion(xml, opts.signerKey ?? IDP_PRIVATE_KEY_PEM);
  return Buffer.from(signed, "utf8").toString("base64");
}

function flowFor(opts: { requestId?: string; relayState?: string } = {}): SamlFlow {
  const issuedAt = Date.now();
  return {
    requestId: opts.requestId ?? "_req-default",
    relayState: opts.relayState ?? "relay-default",
    returnTo: "/console",
    issuedAt,
    expiresAt: issuedAt + 10 * 60 * 1000,
  };
}

async function validate(
  responseOpts: ResponseOptions,
  flowOpts: { requestId?: string; relayState?: string; postedRelayState?: string } = {},
) {
  const flow = flowFor(flowOpts);
  return validateSamlResponse({
    config: samlSpConfig()!,
    bridge: samlBridgeConfig(),
    flow,
    samlResponse: makeSamlResponse({ inResponseTo: flow.requestId, ...responseOpts }),
    relayState: flowOpts.postedRelayState ?? flow.relayState,
  });
}

describe("SAML SP assertion validation", () => {
  beforeEach(configureSaml);

  it("accepts a valid signed assertion and maps it to a tenant bound human identity", async () => {
    const identity = await validate({ tenant: "tenant-acme", nameId: "alice@customer.example", email: "alice@customer.example" });
    expect(identity).toMatchObject({
      issuer: BRIDGE_ISSUER,
      subject: "alice@customer.example",
      tenantId: "tenant-acme",
      email: "alice@customer.example",
    });
    expect(identity.assertionId).toBe("_assertion-default");
    expect(identity.authnContext).toContain("PasswordProtectedTransport");
  });

  it("rejects an unsigned assertion", async () => {
    await expect(validate({ sign: false })).rejects.toThrow();
  });

  it("rejects an assertion signed by the wrong key", async () => {
    await expect(validate({ signerKey: ATTACKER_PRIVATE_KEY_PEM })).rejects.toThrow();
  });

  it("rejects an expired assertion (NotOnOrAfter in the past)", async () => {
    await expect(
      validate({ notBefore: iso(-10 * 60_000), notOnOrAfter: iso(-5 * 60_000) }),
    ).rejects.toThrow();
  });

  it("rejects a wrong audience", async () => {
    await expect(validate({ audience: "https://evil.example/sp" })).rejects.toThrow();
  });

  it("rejects a wrong recipient", async () => {
    await expect(validate({ recipient: "https://evil.example/acs" })).rejects.toThrow();
  });

  it("rejects an InResponseTo that does not match the flow request id", async () => {
    await expect(
      validate({ inResponseTo: "_forged-request" }, { requestId: "_req-real" }),
    ).rejects.toThrow();
  });

  it("rejects a RelayState that does not match the flow", async () => {
    await expect(
      validate({}, { relayState: "relay-real", postedRelayState: "relay-forged" }),
    ).rejects.toThrow("saml_relay_state_mismatch");
  });

  it("rejects a replayed assertion id", async () => {
    const flow = flowFor({ requestId: "_req-replay", relayState: "relay-replay" });
    const samlResponse = makeSamlResponse({ inResponseTo: flow.requestId, assertionId: "_assertion-replay" });
    const args = {
      config: samlSpConfig()!,
      bridge: samlBridgeConfig(),
      flow,
      samlResponse,
      relayState: flow.relayState,
    };
    await expect(validateSamlResponse(args)).resolves.toMatchObject({ subject: "user@customer.example" });
    await expect(validateSamlResponse(args)).rejects.toThrow("saml_assertion_replayed");
  });

  it("fails closed when no tenant can be resolved", async () => {
    await expect(validate({ tenant: null })).rejects.toThrow("saml_tenant_missing");
  });

  it("falls back to the default tenant when the assertion omits one", async () => {
    process.env.SAML_DEFAULT_TENANT_ID = "tenant-fallback";
    const identity = await validate({ tenant: null });
    expect(identity.tenantId).toBe("tenant-fallback");
  });
});

describe("SAML bridge token", () => {
  beforeEach(configureSaml);

  it("mints a JWT the API's OIDC verifier accepts, carrying the mapped tenant", async () => {
    const bridge = samlBridgeConfig();
    const { token } = await mintBridgeToken({
      bridge,
      identity: {
        issuer: BRIDGE_ISSUER,
        subject: "bob@customer.example",
        tenantId: "tenant-acme",
        email: "bob@customer.example",
        displayName: "Bob",
        authnContext: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
        assertionId: "_a1",
      },
    });
    const { keys } = await bridgeJwks(bridge);
    const key = await importJWK(keys[0]!, "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: BRIDGE_ISSUER,
      audience: API_AUDIENCE,
    });
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "saml-bridge-1" });
    expect(payload).toMatchObject({
      sub: "bob@customer.example",
      tenant_id: "tenant-acme",
      amr: ["mfa"],
      auth_via: "saml",
    });
  });
});

describe("SAML SP-initiated flow end to end", () => {
  beforeEach(configureSaml);

  function cookieFrom(response: Response, name: string): string {
    const value = response.headers.get("set-cookie")?.match(
      new RegExp(`(?:^|, )${name}=([^;]+)`),
    )?.[1];
    if (!value) throw new Error(`${name}_cookie_missing`);
    return `${name}=${value}`;
  }

  it("issues an AuthnRequest then turns a valid assertion into a human web session", async () => {
    const started = await samlStart(new NextRequest(
      "https://console.example/api/saml/start?next=%2Fconsumer%2Fprs%2Fpr-9",
    ));
    expect(started.status).toBe(307);
    const location = new URL(started.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(SSO_URL);
    const samlRequest = location.searchParams.get("SAMLRequest")!;
    const relayState = location.searchParams.get("RelayState")!;
    const authnRequestXml = inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8");
    const requestId = authnRequestXml.match(/ID="([^"]+)"/)![1]!;
    const flowCookie = cookieFrom(started, "mendpoint_saml_flow");

    const acsBody = new URLSearchParams({
      SAMLResponse: makeSamlResponse({ inResponseTo: requestId, assertionId: "_assertion-e2e", tenant: "tenant-acme", nameId: "carol@customer.example" }),
      RelayState: relayState,
    });
    const completed = await samlAcs(new NextRequest("https://console.example/api/saml/acs", {
      method: "POST",
      headers: { Cookie: flowCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: acsBody.toString(),
    }));
    expect(completed.status).toBe(307);
    expect(completed.headers.get("location")).toBe("https://console.example/consumer/prs/pr-9");
    const humanCookie = cookieFrom(completed, "mendpoint_web_session");

    const status = await sessionStatus(new NextRequest(
      "https://console.example/api/session",
      { headers: { Cookie: humanCookie } },
    ));
    await expect(status.json()).resolves.toMatchObject({
      authenticated: true,
      subject: { kind: "human_oidc" },
    });
  });
});

describe("SAML unconfigured keeps existing auth untouched", () => {
  it("reports SAML disabled and OIDC unaffected when SAML env is absent", async () => {
    process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-session-secret-value";
    for (const key of ["SAML_IDP_SSO_URL", "SAML_IDP_CERT", "SAML_SP_ENTITY_ID", "SAML_ACS_URL", "SAML_JWT_ISSUER"]) {
      delete process.env[key];
    }
    process.env.OIDC_ISSUER = "https://identity.example";
    process.env.OIDC_AUDIENCE = "mendpoint-api";
    process.env.OIDC_CLIENT_ID = "mendpoint-web";
    process.env.OIDC_REDIRECT_URI = "https://console.example/api/oidc/callback";

    await expect((await samlConfig()).json()).resolves.toEqual({ enabled: false });
    // OIDC remains enabled and untouched.
    await expect((oidcConfig()).json()).resolves.toEqual({ enabled: true });

    const started = await samlStart(new NextRequest("https://console.example/api/saml/start"));
    expect(started.status).toBe(503);
    await expect(started.json()).resolves.toEqual({ error: "saml_not_configured" });

    const acs = await samlAcs(new NextRequest("https://console.example/api/saml/acs", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "SAMLResponse=x&RelayState=y",
    }));
    expect(acs.status).toBe(503);
    await expect(acs.json()).resolves.toEqual({ error: "saml_not_configured" });
  });
});
