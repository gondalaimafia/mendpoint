export const REQUIRED_EVIDENCE_SECTIONS = [
  "Summary",
  "Why",
  "Exact files",
  "Verification results",
  "Risks",
  "Rollback",
  "Evidence",
  "Reviewer ownership",
  "Delivery controls",
] as const;

export type PrEvidenceSection = {
  title: (typeof REQUIRED_EVIDENCE_SECTIONS)[number];
  content: string;
};

export function parsePrEvidence(body: string): {
  sections: PrEvidenceSection[];
  complete: boolean;
} {
  const markers = [
    "### Structured Fettler draft package",
    "### Structured Warden draft package",
  ] as const;
  const match = markers
    .map((marker) => ({ marker, index: body.indexOf(marker) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index)[0];
  if (!match) return { sections: [], complete: false };
  const packageBody = body.slice(match.index + match.marker.length);
  const parsed = new Map<string, string>();
  for (const block of packageBody.split(/^#### /m).slice(1)) {
    const lineBreak = block.search(/\r?\n/);
    if (lineBreak < 0) continue;
    parsed.set(block.slice(0, lineBreak).trim(), block.slice(lineBreak).trim());
  }
  const sections = REQUIRED_EVIDENCE_SECTIONS.flatMap((title) => {
    const content = parsed.get(title);
    return content ? [{ title, content }] : [];
  });
  return {
    sections,
    complete: sections.length === REQUIRED_EVIDENCE_SECTIONS.length,
  };
}
