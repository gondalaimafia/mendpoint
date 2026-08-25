import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exportAuditCsv, recordAudit, type AppDb } from "./index.js";

const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("audit CSV export", () => {
  it("prevents spreadsheet formulas in every exported cell", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-audit-export-"));
    const db = createDb(join(directory, "audit.sqlite"));
    opened.push({ db, directory });
    for (const [index, actor] of [
      '=HYPERLINK("https://attacker.example")',
      "+SUM(1,1)",
      "-2+3",
      "@IMPORTXML(A1)",
      "\t=cmd",
      " =1+1",
    ].entries()) {
      recordAudit(db, {
        id: `audit-${index}`,
        tenantId: "tenant-a",
        actor,
        action: "audit.exported",
        resourceType: "audit",
      });
    }

    const csv = exportAuditCsv(db, 20, "tenant-a");
    expect(csv).toContain("\"'=HYPERLINK(\"\"https://attacker.example\"\")\"");
    expect(csv).toContain("\"'+SUM(1,1)\"");
    expect(csv).toContain("\"'-2+3\"");
    expect(csv).toContain("\"'@IMPORTXML(A1)\"");
    expect(csv).toContain("\"'\t=cmd\"");
    expect(csv).toContain("\"' =1+1\"");
    expect(csv).not.toMatch(/(?:^|,)\"[=+\-@\t\r]/m);
  });

  it("rejects unsafe limits at the database boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-audit-limit-"));
    const db = createDb(join(directory, "audit.sqlite"));
    opened.push({ db, directory });
    for (const limit of [0, -1, 1.5, 20_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => exportAuditCsv(db, limit, "tenant-a"), String(limit))
        .toThrow("audit_export_limit_invalid");
    }
  });
});
