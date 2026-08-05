import { describe, expect, it } from "vitest";
import { redactSourceForModel } from "./source-redaction.js";

const LIMIT = 20_000;

describe("Warden source redaction", () => {
  it.each([
    ["GitHub fine grained PAT", `github_pat_${"A1_".repeat(30)}`, "githubPat"],
    ["GitHub classic token", `ghp_${"aB1".repeat(14)}`, "githubPat"],
    ["AWS access key ID", "AKIAIOSFODNN7EXAMPLE", "awsKeyId"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureVALUE123", "jwt"],
    ["Bearer token", `Bearer ${"aB1._-".repeat(10)}`, "bearerToken"],
    ["OpenAI key", `sk-proj-${"aB1_".repeat(12)}`, "vendorKey"],
    ["Anthropic key", `sk-ant-api03-${"aB1_".repeat(12)}`, "vendorKey"],
    ["GitLab key", `glpat-${"aB1".repeat(12)}`, "vendorKey"],
    ["Slack key", `xoxb-${"1234567890"}-${"aB".repeat(16)}`, "vendorKey"],
    ["Stripe key", `sk_live_${"aB1".repeat(12)}`, "vendorKey"],
    ["webhook key", `whsec_${"aB1".repeat(12)}`, "vendorKey"],
    ["npm key", `npm_${"aB1".repeat(14)}`, "vendorKey"],
    ["Hugging Face key", `hf_${"aB1".repeat(12)}`, "vendorKey"],
    ["Google API key", `AIza${"aB1_".repeat(9)}`.slice(0, 39), "vendorKey"],
  ] as const)("redacts %s", (_label, secret, category) => {
    const result = redactSourceForModel(`before ${secret} after`, LIMIT);

    expect(result.excluded).toBe(false);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain("[REDACTED_");
    expect(result.counts[category]).toBe(1);
    expect(result.counts.total).toBe(1);
  });

  it("redacts complete PEM blocks across lines", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "moreSecretMaterial1234567890=",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const result = redactSourceForModel(`const key = \`${pem}\`;`, LIMIT);

    expect(result.excluded).toBe(false);
    expect(result.text).not.toContain("moreSecretMaterial");
    expect(result.text).toContain("[REDACTED_PEM_BLOCK]");
    expect(result.counts.pemBlock).toBe(1);
  });

  it.each([
    "postgresql://alice:correct-horse@example.com:5432/app?sslmode=require",
    "mysql://root:p%40ssword@db.internal/orders",
    "mongodb+srv://service:secret@cluster.example.net/main",
    "rediss://default:secret@cache.example.net:6380/0",
  ])("redacts credential bearing database URL %s", (url) => {
    const result = redactSourceForModel(`DATABASE_URL=${url}`, LIMIT);

    expect(result.excluded).toBe(false);
    expect(result.text).not.toContain(url);
    expect(result.text).not.toContain("correct-horse");
    expect(result.text).not.toContain("p%40ssword");
    expect(result.counts.secretAssignment + result.counts.databaseUrl).toBeGreaterThan(0);
  });

  it.each([
    ["environment assignment", "PASSWORD=correct-horse-battery-staple"],
    ["JSON assignment", `"access_token": "${"aB1".repeat(15)}"`],
    ["camel case assignment", `const clientSecret = "${"zY9".repeat(15)}";`],
    ["multiline assignment", `apiKey =\n  "${"qR7".repeat(15)}"`],
    ["YAML assignment", `private_key: ${"kL5".repeat(15)}`],
  ])("redacts generic secret in %s", (_label, source) => {
    const result = redactSourceForModel(source, LIMIT);

    expect(result.excluded).toBe(false);
    expect(result.text).not.toMatch(/correct-horse|aB1aB1|zY9zY9|qR7qR7|kL5kL5/);
    expect(result.counts.secretAssignment).toBe(1);
  });

  it("redacts multiline YAML secret blocks without leaving continuation lines", () => {
    const source = [
      "password: |",
      "  first-secret-line",
      "  second-secret-line",
      "safe: visible",
    ].join("\n");
    const result = redactSourceForModel(source, LIMIT);

    expect(result.excluded).toBe(false);
    expect(result.text).not.toContain("first-secret-line");
    expect(result.text).not.toContain("second-secret-line");
    expect(result.text).toContain("safe: visible");
    expect(result.counts.secretAssignment).toBe(1);
  });

  it.each([
    ["GitHub", "github_pat_Ab12", "githubPat"],
    ["classic GitHub", "ghp_Ab12", "githubPat"],
    ["Bearer", "Bearer Ab12", "bearerToken"],
    ["vendor", "sk-proj-Ab12Cd34", "vendorKey"],
  ] as const)("redacts a partial %s credential instead of leaking a truncated prefix", (
    _label,
    partial,
    category,
  ) => {
    const result = redactSourceForModel(`value=${partial}`, LIMIT);

    expect(result.excluded).toBe(false);
    expect(result.text).not.toContain(partial);
    expect(result.counts[category]).toBe(1);
  });

  it("redacts before truncation so no credential prefix crosses the boundary", () => {
    const secret = `github_pat_${"Ab1_".repeat(30)}`;
    const source = `${"x".repeat(38)}${secret} trailing`;
    const result = redactSourceForModel(source, 50);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(50);
    expect(result.text).not.toContain("github_pat_");
    for (let prefixLength = 4; prefixLength <= secret.length; prefixLength++) {
      expect(result.text).not.toContain(secret.slice(0, prefixLength));
    }
    expect(result.counts.githubPat).toBe(1);
  });

  it("reports complete counts and preserves ordinary source", () => {
    const source = [
      "export const endpoint = 'https://api.example.com/v1';",
      `const token = "${"aB1".repeat(15)}";`,
      "export const sha = '0123456789abcdef0123456789abcdef01234567';",
    ].join("\n");
    const result = redactSourceForModel(source, LIMIT);

    expect(result).toMatchObject({
      excluded: false,
      exclusionReason: null,
      originalChars: source.length,
      truncated: false,
    });
    expect(result.text).toContain("https://api.example.com/v1");
    expect(result.text).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(result.counts).toMatchObject({ total: 1, secretAssignment: 1, ambiguous: 0 });
    expect(result.outputChars).toBe(result.text.length);
    expect(result.redactedChars).toBe(result.text.length);
  });

  it.each([
    ["NUL byte", "safe\u0000unsafe", "unsafe_control_character"],
    ["unterminated PEM", "-----BEGIN PRIVATE KEY-----\nsecret", "ambiguous_pem"],
    [
      "unclassified high entropy token",
      `const opaque = "${"aB3dE6fG9hJ2kL5mN8pQ1rS4tV7wX0yZ".repeat(2)}";`,
      "ambiguous_high_entropy_token",
    ],
  ] as const)("excludes %s instead of risking disclosure", (_label, source, reason) => {
    const result = redactSourceForModel(source, LIMIT);

    expect(result.excluded).toBe(true);
    expect(result.text).toBe("");
    expect(result.exclusionReason).toBe(reason);
    expect(result.counts.ambiguous).toBeGreaterThan(0);
  });

  it("fails closed for an invalid output limit", () => {
    const result = redactSourceForModel("export const safe = true;", Number.POSITIVE_INFINITY);

    expect(result).toMatchObject({
      text: "",
      excluded: true,
      exclusionReason: "invalid_limit",
    });
  });
});
