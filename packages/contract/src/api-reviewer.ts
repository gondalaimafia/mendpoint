/**
 * Read-only API design critic — scores style tests don't catch.
 * Idempotency, pagination, error taxonomy, versioning.
 */
export type ApiReviewFinding = {
  id: string;
  severity: "info" | "warn" | "block";
  category: "idempotency" | "pagination" | "errors" | "versioning" | "auth" | "naming";
  message: string;
  path?: string;
};

export type ApiReviewReport = {
  score: number; // 0–100
  findings: ApiReviewFinding[];
  summary: string;
  markdown: string;
};

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

/**
 * Heuristic review of an OpenAPI-like document.
 */
export function reviewOpenApiDesign(spec: unknown): ApiReviewReport {
  const findings: ApiReviewFinding[] = [];
  const root = asObj(spec);
  const paths = asObj(root.paths);
  let pathCount = 0;
  let postWithoutIdempotencyHint = 0;
  let listWithoutPagination = 0;
  let missing4xx = 0;
  let unversioned = 0;

  const openapi = String(root.openapi ?? root.swagger ?? "");
  if (!openapi) {
    findings.push({
      id: "no-openapi-version",
      severity: "warn",
      category: "versioning",
      message: "Document missing openapi/swagger version field",
    });
  }

  // Prefer /v1 style paths
  for (const [p, item] of Object.entries(paths)) {
    pathCount++;
    if (!/\/v\d+\//.test(p) && !/^\/v\d+$/.test(p)) {
      unversioned++;
    }
    const methods = asObj(item);
    for (const [method, opRaw] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const op = asObj(opRaw);
      const responses = asObj(op.responses);
      const has4xx = Object.keys(responses).some((c) => c.startsWith("4"));
      if (!has4xx) missing4xx++;

      if (method === "post") {
        const params = Array.isArray(op.parameters) ? op.parameters : [];
        const headers = params.filter(
          (x) => asObj(x).in === "header",
        ) as Json[];
        const hasIdem =
          headers.some((h) =>
            /idempotency/i.test(String(h.name ?? "")),
          ) ||
          /idempotency/i.test(JSON.stringify(op));
        if (!hasIdem) postWithoutIdempotencyHint++;
      }

      if (method === "get" && /s$|list|search/i.test(p)) {
        const params = Array.isArray(op.parameters) ? op.parameters : [];
        const names = params.map((x) => String(asObj(x).name ?? "").toLowerCase());
        const hasPage = names.some((n) =>
          /page|cursor|limit|starting_after|offset|continuation/.test(n),
        );
        if (!hasPage) listWithoutPagination++;
      }
    }
  }

  if (postWithoutIdempotencyHint > 0) {
    findings.push({
      id: "post-idempotency",
      severity: "warn",
      category: "idempotency",
      message: `${postWithoutIdempotencyHint} POST operation(s) lack Idempotency-Key (or equivalent) documentation`,
    });
  }
  if (listWithoutPagination > 0) {
    findings.push({
      id: "list-pagination",
      severity: "warn",
      category: "pagination",
      message: `${listWithoutPagination} list-like GET path(s) lack pagination parameters`,
    });
  }
  if (missing4xx > 0) {
    findings.push({
      id: "error-taxonomy",
      severity: "info",
      category: "errors",
      message: `${missing4xx} operation(s) document no 4xx responses`,
    });
  }
  if (pathCount > 0 && unversioned === pathCount) {
    findings.push({
      id: "path-versioning",
      severity: "warn",
      category: "versioning",
      message: "No /vN/ path prefix detected — confirm versioning strategy (header vs URL)",
    });
  }

  // Score: start 100, subtract
  let score = 100;
  for (const f of findings) {
    if (f.severity === "block") score -= 25;
    else if (f.severity === "warn") score -= 10;
    else score -= 3;
  }
  score = Math.max(0, Math.min(100, score));

  const summary =
    findings.length === 0
      ? "API design review: no heuristic issues"
      : `API design review: ${findings.length} finding(s), score ${score}/100`;

  const markdown = [
    "### Warden API reviewer (read-only critic)",
    "",
    `- **Score:** ${score}/100`,
    `- **Summary:** ${summary}`,
    "",
    ...findings.map(
      (f) =>
        `- **[${f.severity}]** \`${f.category}\`: ${f.message}`,
    ),
    "",
    "_Critic does not auto-merge. Style issues tests often miss (idempotency, pagination, errors, versioning)._",
  ].join("\n");

  return { score, findings, summary, markdown };
}
