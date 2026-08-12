import React from "react";

export type DiffLine = {
  type: "add" | "del" | "ctx";
  text: string;
  line?: number | string;
};
export type DiffHunk = { header?: string; lines: DiffLine[] };

/**
 * The signature object of the product. Added lines carry the green (emerald)
 * bar and ink, removed lines the red (destructive) bar and ink — these two
 * roles are never rebranded. Mono, with a line-number gutter. All color comes
 * from the DS diff-* tokens.
 */
export function DiffView({
  path,
  hunks,
  additions,
  deletions,
  collapsedNote,
}: {
  path?: string;
  hunks: DiffHunk[];
  additions?: number;
  deletions?: number;
  collapsedNote?: string;
}) {
  const add =
    additions ??
    hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.type === "add").length,
      0,
    );
  const del =
    deletions ??
    hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.type === "del").length,
      0,
    );

  return (
    <div className="ds-diff">
      {path && (
        <div className="ds-diff__head">
          <span className="ds-diff__path">{path}</span>
          <span className="ds-diff__stat">
            <span className="add">+{add}</span>
            <span className="del">&minus;{del}</span>
          </span>
        </div>
      )}
      {hunks.map((h, hi) => (
        <div className="ds-diff__hunk" key={hi}>
          {h.header && <div className="ds-diff__hunkhead">{h.header}</div>}
          {h.lines.map((l, li) => (
            <div
              className={`ds-diff__row ${
                l.type === "add"
                  ? "ds-diff__row--add"
                  : l.type === "del"
                    ? "ds-diff__row--del"
                    : ""
              }`.trim()}
              key={li}
            >
              <span className="ds-diff__gutter">{l.line ?? ""}</span>
              <span className="ds-diff__sign">
                {l.type === "add" ? "+" : l.type === "del" ? "−" : ""}
              </span>
              <span className="ds-diff__code">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
      {collapsedNote && <div className="ds-diff__note">{collapsedNote}</div>}
    </div>
  );
}
