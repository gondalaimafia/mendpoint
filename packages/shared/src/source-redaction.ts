export type SourceRedactionExclusionReason =
  | "invalid_limit"
  | "unsafe_control_character"
  | "ambiguous_pem"
  | "ambiguous_high_entropy_token";

export type SourceRedactionCounts = Readonly<{
  total: number;
  githubPat: number;
  awsKeyId: number;
  pemBlock: number;
  jwt: number;
  databaseUrl: number;
  bearerToken: number;
  vendorKey: number;
  secretAssignment: number;
  ambiguous: number;
}>;

export type SourceRedactionResult = Readonly<{
  text: string;
  counts: SourceRedactionCounts;
  originalChars: number;
  redactedChars: number;
  outputChars: number;
  truncated: boolean;
  excluded: boolean;
  exclusionReason: SourceRedactionExclusionReason | null;
}>;

type MutableCounts = {
  -readonly [Key in keyof SourceRedactionCounts]: SourceRedactionCounts[Key];
};

type RedactionCategory = Exclude<keyof SourceRedactionCounts, "total" | "ambiguous">;

const MAX_OUTPUT_CHARS = 1_000_000;
const REDACTED = {
  githubPat: "[REDACTED_GITHUB_TOKEN]",
  awsKeyId: "[REDACTED_AWS_KEY_ID]",
  pemBlock: "[REDACTED_PEM_BLOCK]",
  jwt: "[REDACTED_JWT]",
  databaseUrl: "[REDACTED_DATABASE_URL]",
  bearerToken: "Bearer [REDACTED_TOKEN]",
  vendorKey: "[REDACTED_VENDOR_KEY]",
  secretAssignment: "[REDACTED_SECRET]",
} as const satisfies Readonly<Record<RedactionCategory, string>>;

const PEM_BLOCK = /-----BEGIN ([A-Z0-9][A-Z0-9 ]{0,80})-----[\s\S]*?-----END \1-----/g;
const DATABASE_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|sqlserver):\/\/[^\s:@/]+:[^\s@/]+@[^\s"'`<>]+/gi;
const GITHUB_PAT = /(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})\b/g;
const PARTIAL_GITHUB_PAT = /(?:github_pat_[A-Za-z0-9_]{1,19}|gh[pousr]_[A-Za-z0-9]{1,19})\b/g;
const AWS_KEY_ID = /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const PARTIAL_BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{1,11}=*/gi;
const VENDOR_KEY = /\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|SK[a-f0-9]{32})\b/gi;
const PARTIAL_VENDOR_KEY = /\bsk-(?:(?:ant|proj|svcacct)-)?[A-Za-z0-9_-]{1,19}\b/gi;
const SECRET_NAME = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|credential)`;
const SECRET_ASSIGNMENT_PREFIX = String.raw`((?:["']?)\b${SECRET_NAME}\b(?:["']?)\s*[:=]\s*)`;
const MULTILINE_YAML_ASSIGNMENT = new RegExp(
  String.raw`((?:["']?)\b${SECRET_NAME}\b(?:["']?)\s*:\s*)[|>][+-]?\d?[ \t]*(?:#[^\r\n]*)?\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))+`,
  "gi",
);
const DOUBLE_QUOTED_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_ASSIGNMENT_PREFIX}"(?:\\.|[^"\\\r\n])*"`,
  "gi",
);
const SINGLE_QUOTED_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_ASSIGNMENT_PREFIX}'(?:\\.|[^'\\\r\n])*'`,
  "gi",
);
const BACKTICK_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_ASSIGNMENT_PREFIX}\x60(?:\\.|[^\x60\\])*\x60`,
  "gi",
);
const UNQUOTED_ASSIGNMENT = new RegExp(
  String.raw`${SECRET_ASSIGNMENT_PREFIX}(?!\[REDACTED_)([^\s,;}\]"'\x60]+)`,
  "gi",
);
const AMBIGUOUS_TOKEN = /[A-Za-z0-9+/_=-]{40,512}/g;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function emptyCounts(): MutableCounts {
  return {
    total: 0,
    githubPat: 0,
    awsKeyId: 0,
    pemBlock: 0,
    jwt: 0,
    databaseUrl: 0,
    bearerToken: 0,
    vendorKey: 0,
    secretAssignment: 0,
    ambiguous: 0,
  };
}

function excludedResult(
  source: string,
  counts: MutableCounts,
  reason: SourceRedactionExclusionReason,
): SourceRedactionResult {
  counts.ambiguous++;
  return {
    text: "",
    counts: { ...counts },
    originalChars: source.length,
    redactedChars: 0,
    outputChars: 0,
    truncated: false,
    excluded: true,
    exclusionReason: reason,
  };
}

function redact(
  source: string,
  pattern: RegExp,
  category: RedactionCategory,
  counts: MutableCounts,
  replacement: string | ((match: string, ...groups: string[]) => string) = REDACTED[category],
): string {
  pattern.lastIndex = 0;
  return source.replace(pattern, (match, ...args: unknown[]) => {
    counts[category]++;
    counts.total++;
    if (typeof replacement === "string") return replacement;
    const groups = args.slice(0, -2).map(String);
    return replacement(match, ...groups);
  });
}

function pemIsAmbiguous(source: string): boolean {
  const begins = [...source.matchAll(/-----BEGIN ([A-Z0-9][A-Z0-9 ]{0,80})-----/g)]
    .map((match) => match[1]);
  const ends = [...source.matchAll(/-----END ([A-Z0-9][A-Z0-9 ]{0,80})-----/g)]
    .map((match) => match[1]);
  if (begins.length !== ends.length) return begins.length > 0 || ends.length > 0;
  return begins.some((label, index) => label !== ends[index]);
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function hasAmbiguousHighEntropyToken(source: string): boolean {
  AMBIGUOUS_TOKEN.lastIndex = 0;
  for (const match of source.matchAll(AMBIGUOUS_TOKEN)) {
    const token = match[0];
    if (/^\[REDACTED_[A-Z_]+\]$/.test(token)) continue;
    if (/^[a-f0-9]+$/i.test(token)) continue;
    if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) continue;
    if (shannonEntropy(token) >= 4.25) return true;
  }
  return false;
}

/**
 * Remove secret material from an untrusted repository excerpt before applying
 * its output limit. Ambiguous input is excluded instead of partially exposed.
 */
export function redactSourceForModel(
  source: string,
  maxChars: number,
): SourceRedactionResult {
  const counts = emptyCounts();
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > MAX_OUTPUT_CHARS
  ) {
    return excludedResult(source, counts, "invalid_limit");
  }
  if (UNSAFE_CONTROL_CHARACTER.test(source)) {
    return excludedResult(source, counts, "unsafe_control_character");
  }
  if (pemIsAmbiguous(source)) {
    return excludedResult(source, counts, "ambiguous_pem");
  }

  let redacted = source;
  redacted = redact(redacted, PEM_BLOCK, "pemBlock", counts);
  redacted = redact(redacted, DATABASE_URL, "databaseUrl", counts);
  redacted = redact(redacted, GITHUB_PAT, "githubPat", counts);
  redacted = redact(redacted, PARTIAL_GITHUB_PAT, "githubPat", counts);
  redacted = redact(redacted, AWS_KEY_ID, "awsKeyId", counts);
  redacted = redact(redacted, JWT, "jwt", counts);
  redacted = redact(redacted, BEARER_TOKEN, "bearerToken", counts);
  redacted = redact(redacted, PARTIAL_BEARER_TOKEN, "bearerToken", counts);
  redacted = redact(redacted, VENDOR_KEY, "vendorKey", counts);
  redacted = redact(redacted, PARTIAL_VENDOR_KEY, "vendorKey", counts);
  redacted = redact(
    redacted,
    MULTILINE_YAML_ASSIGNMENT,
    "secretAssignment",
    counts,
    (match, prefix) => {
      const lineEnding = match.endsWith("\r\n")
        ? "\r\n"
        : match.endsWith("\n")
          ? "\n"
          : "";
      return `${prefix}${REDACTED.secretAssignment}${lineEnding}`;
    },
  );
  redacted = redact(
    redacted,
    DOUBLE_QUOTED_ASSIGNMENT,
    "secretAssignment",
    counts,
    (_match, prefix) => `${prefix}"${REDACTED.secretAssignment}"`,
  );
  redacted = redact(
    redacted,
    SINGLE_QUOTED_ASSIGNMENT,
    "secretAssignment",
    counts,
    (_match, prefix) => `${prefix}'${REDACTED.secretAssignment}'`,
  );
  redacted = redact(
    redacted,
    BACKTICK_ASSIGNMENT,
    "secretAssignment",
    counts,
    (_match, prefix) => `${prefix}\`${REDACTED.secretAssignment}\``,
  );
  redacted = redact(
    redacted,
    UNQUOTED_ASSIGNMENT,
    "secretAssignment",
    counts,
    (_match, prefix) => `${prefix}${REDACTED.secretAssignment}`,
  );

  if (hasAmbiguousHighEntropyToken(redacted)) {
    return excludedResult(source, counts, "ambiguous_high_entropy_token");
  }

  const text = redacted.slice(0, maxChars);
  return {
    text,
    counts: { ...counts },
    originalChars: source.length,
    redactedChars: redacted.length,
    outputChars: text.length,
    truncated: redacted.length > maxChars,
    excluded: false,
    exclusionReason: null,
  };
}
