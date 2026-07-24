/**
 * Heuristic changelog / deprecation blurb parser (no LLM).
 * Extracts field mentions, deprecation dates, and rename pairs for Warden surfaces.
 */

export type ChangelogParseResult = {
  fields: string[];
  deprecationAt?: string;
  replacements: Array<{ from: string; to: string }>;
  summary: string;
};

/** Identifier: snake_case, camelCase, PascalCase, dotted paths (no trailing punctuation) */
const IDENT = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*`;

/** snake_case / camelCase / dotted API field tokens */
const FIELD_RE =
  /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:\.[a-z][a-z0-9_]*)+)\b/g;

/** ISO dates and common prose dates */
const DATE_RE =
  /\b(20\d{2}-\d{2}-\d{2})\b|\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2})\b/gi;

/**
 * rename / replace patterns:
 * - rename X to Y / renamed X → Y
 * - X → Y / X -> Y
 * - Use Y instead of X / replace X with Y
 * - Deprecating field X ... Use Y
 */
const RENAME_PATTERNS: Array<{ re: RegExp; swap?: boolean }> = [
  {
    re: new RegExp(
      String.raw`\brename(?:d|s)?\s+[\`'"*]*(${IDENT})[\`'"*]*\s*(?:→|->|to|as)\s*[\`'"*]*(${IDENT})[\`'"*]*`,
      "gi",
    ),
  },
  {
    re: new RegExp(
      String.raw`[\`'"*](${IDENT})[\`'"*]\s*(?:→|->)\s*[\`'"*]?(${IDENT})[\`'"*]?`,
      "g",
    ),
  },
  {
    re: new RegExp(
      String.raw`\breplace(?:s|d)?\s+[\`'"*]*(${IDENT})[\`'"*]*\s+with\s+[\`'"*]*(${IDENT})[\`'"*]*`,
      "gi",
    ),
  },
  {
    // use Y instead of X → swap to from=X to=Y
    re: new RegExp(
      String.raw`\buse\s+[\`'"*]*(${IDENT})[\`'"*]*\s+instead\s+of\s+[\`'"*]*(${IDENT})[\`'"*]*`,
      "gi",
    ),
    swap: true,
  },
  {
    // Deprecating request field amount_cents on DATE. Use amount.
    re: new RegExp(
      String.raw`\bdeprecat\w+\b[\s\S]{0,160}?\b(?:field|param(?:eter)?|property|argument)\s+[\`'"*]*(${IDENT})[\`'"*]*[\s\S]{0,120}?\.\s*Use\s+[\`'"*]*(${IDENT})[\`'"*]*`,
      "gi",
    ),
  },
  {
    // The Body field is deprecated ... Use Content.
    re: new RegExp(
      String.raw`\b(?:the\s+)?[\`'"*]*(${IDENT})[\`'"*]*\s+(?:field|param(?:eter)?|property)\s+is\s+deprecated\b[\s\S]{0,120}?\.\s*Use\s+[\`'"*]*(${IDENT})[\`'"*]*`,
      "gi",
    ),
  },
];

/** Path-like tokens often mentioned in changelogs */
const PATH_RE = /\/v\d+\/[A-Za-z0-9_{}\/-]+/g;

const STOP_WORDS = new Set([
  "deprecating",
  "deprecated",
  "deprecation",
  "request",
  "response",
  "field",
  "fields",
  "parameter",
  "parameters",
  "endpoint",
  "endpoints",
  "api",
  "breaking",
  "change",
  "changes",
  "instead",
  "with",
  "from",
  "into",
  "will",
  "been",
  "have",
  "this",
  "that",
  "after",
  "before",
  "until",
  "starting",
  "please",
  "migrate",
  "migration",
  "version",
  "payload",
  "payloads",
  "create",
  "retrieve",
  "removed",
  "added",
  "using",
  "must",
  "should",
  "now",
  "was",
  "were",
  "are",
  "the",
  "and",
  "for",
  "on",
]);

function normalizeDate(raw: string): string {
  const iso = raw.match(/^(20\d{2}-\d{2}-\d{2})$/);
  if (iso) return iso[1]!;
  const local = new Date(raw);
  if (!Number.isNaN(local.getTime())) {
    const ly = local.getFullYear();
    const lm = String(local.getMonth() + 1).padStart(2, "0");
    const ld = String(local.getDate()).padStart(2, "0");
    return `${ly}-${lm}-${ld}`;
  }
  return raw;
}

function extractDeprecationAt(text: string): string | undefined {
  const depCtx =
    text.match(
      /deprecat\w*[^.]{0,100}?\b(20\d{2}-\d{2}-\d{2})\b|\b(20\d{2}-\d{2}-\d{2})\b[^.]{0,100}?deprecat\w*/i,
    ) ??
    text.match(
      /deprecat\w*[\s\S]{0,120}?((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2})/i,
    ) ??
    text.match(
      /(?:as of|on|until|before)\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2})/i,
    );
  if (depCtx) {
    const raw = (depCtx[1] || depCtx[2] || "").trim();
    if (raw) return normalizeDate(raw);
  }
  DATE_RE.lastIndex = 0;
  const m = DATE_RE.exec(text);
  if (m) {
    const raw = (m[1] || m[2] || "").trim();
    if (raw) return normalizeDate(raw);
  }
  return undefined;
}

function extractReplacements(text: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();

  for (const { re, swap } of RENAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let from = m[1]!;
      let to = m[2]!;
      if (swap) {
        const y = from;
        const x = to;
        from = x;
        to = y;
      }
      from = from.replace(/^[`'"*]+|[`'"*]+$/g, "");
      to = to.replace(/^[`'"*]+|[`'"*]+$/g, "");
      if (!from || !to || from === to) continue;
      if (STOP_WORDS.has(from.toLowerCase()) || STOP_WORDS.has(to.toLowerCase())) continue;
      const key = `${from}=>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to });
    }
  }

  return out;
}

function extractFields(text: string, replacements: Array<{ from: string; to: string }>): string[] {
  const fields = new Set<string>();
  for (const r of replacements) {
    fields.add(r.from);
    fields.add(r.to);
  }

  FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_RE.exec(text)) !== null) {
    const tok = m[1]!;
    if (STOP_WORDS.has(tok.toLowerCase())) continue;
    if (tok.includes("_") || tok.includes(".") || /[a-z][A-Z]/.test(tok)) {
      fields.add(tok);
    }
  }

  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    fields.add(m[0]!);
  }

  const tick = text.matchAll(/`([A-Za-z0-9_./{}-]+)`/g);
  for (const t of tick) {
    const v = t[1]!;
    if (v.length >= 2 && !STOP_WORDS.has(v.toLowerCase())) fields.add(v);
  }

  return [...fields];
}

function buildSummary(
  text: string,
  fields: string[],
  replacements: Array<{ from: string; to: string }>,
  deprecationAt?: string,
): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  if (firstLine && firstLine.length <= 200) {
    return firstLine;
  }
  const bits: string[] = [];
  if (replacements.length) {
    bits.push(replacements.map((r) => `${r.from} → ${r.to}`).join(", "));
  } else if (fields.length) {
    bits.push(`fields: ${fields.slice(0, 5).join(", ")}`);
  }
  if (deprecationAt) bits.push(`deprecates ${deprecationAt}`);
  if (bits.length) return bits.join("; ");
  return text.slice(0, 160).trim();
}

/**
 * Parse a changelog entry or deprecation blurb into structured hints.
 */
export function parseChangelogEntry(text: string): ChangelogParseResult {
  const cleaned = (text ?? "").trim();
  if (!cleaned) {
    return { fields: [], replacements: [], summary: "" };
  }

  const deprecationAt = extractDeprecationAt(cleaned);
  const replacements = extractReplacements(cleaned);
  const fields = extractFields(cleaned, replacements);
  const summary = buildSummary(cleaned, fields, replacements, deprecationAt);

  return {
    fields,
    ...(deprecationAt ? { deprecationAt } : {}),
    replacements,
    summary,
  };
}
