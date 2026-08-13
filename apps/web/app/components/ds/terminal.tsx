import React from "react";

export type TerminalLine = {
  type: "cmd" | "out" | "ok" | "err" | "warn";
  text: string;
};

const ROW_CLASS: Record<TerminalLine["type"], string> = {
  cmd: "",
  out: "ds-term__out",
  ok: "ds-term__ok",
  err: "ds-term__err",
  warn: "ds-term__warn",
};

/**
 * CLI transcript. Used on the marketing site, in docs, and in run logs. A bare
 * string is treated as a command line and gets the prompt; `out`/`ok`/`err`/
 * `warn` lines hide the prompt and carry their DS role color.
 */
export function Terminal({
  lines,
  prompt = "$",
  caret = false,
}: {
  lines: (string | TerminalLine)[];
  prompt?: string;
  caret?: boolean;
}) {
  return (
    <div className="ds-term">
      {lines.map((l, i) => {
        const line: TerminalLine =
          typeof l === "string" ? { type: "cmd", text: l } : l;
        const isCmd = line.type === "cmd";
        return (
          <div className="ds-term__row" key={i}>
            <span
              className={`ds-term__prompt ${isCmd ? "" : "ds-term__prompt--hidden"}`.trim()}
            >
              {prompt}
            </span>
            <span className={ROW_CLASS[line.type]}>{line.text}</span>
          </div>
        );
      })}
      {caret && (
        <div className="ds-term__row">
          <span className="ds-term__prompt">{prompt}</span>
          <span className="ds-term__caret" aria-hidden />
        </div>
      )}
    </div>
  );
}
