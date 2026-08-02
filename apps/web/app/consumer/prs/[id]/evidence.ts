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
  const marker = "### Structured Warden draft package";
  const packageBody = body.slice(body.indexOf(marker) + marker.length);
  if (!body.includes(marker)) return { sections: [], complete: false };
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
