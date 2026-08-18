import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FileRecord } from "@mendpoint/codebase-index";
import {
  buildGoDirMap,
  buildJavaMaps,
  buildLanguageGraphs,
  buildProviderReachability,
  buildPythonModuleMaps,
  resolveGoImport,
  resolveJavaImport,
  resolvePythonImport,
} from "./lang-import-graph.js";

type F = Pick<FileRecord, "path" | "imports" | "language">;

function py(path: string, imports: string[]): F {
  return { path, imports, language: "python" };
}
function go(path: string, imports: string[]): F {
  return { path, imports, language: "go" };
}
function java(path: string, imports: string[]): F {
  return { path, imports, language: "java" };
}

describe("python module resolution", () => {
  const files: F[] = [
    py("app/__init__.py", []),
    py("app/providers/__init__.py", []),
    py("app/providers/payments_client.py", ["app.models.payment"]),
    py("app/models/__init__.py", []),
    py("app/models/payment.py", ["pydantic"]),
    py("app/services/charge_service.py", [
      "app.providers.payments_client",
      "app.models.charge",
    ]),
    py("app/models/charge.py", []),
  ];
  const { moduleToFile, firstPartyRoots } = buildPythonModuleMaps(files);

  it("resolves a dotted absolute import to its module file", () => {
    const r = resolvePythonImport(
      "app/services/charge_service.py",
      "app.providers.payments_client",
      moduleToFile,
      firstPartyRoots,
    );
    expect(r.targets).toEqual(["app/providers/payments_client.py"]);
  });

  it("resolves a relative import against the importing package", () => {
    const r = resolvePythonImport(
      "app/services/charge_service.py",
      "..models.payment",
      moduleToFile,
      firstPartyRoots,
    );
    expect(r.targets).toEqual(["app/models/payment.py"]);
  });

  it("resolves a package (__init__.py) import", () => {
    const r = resolvePythonImport(
      "app/services/charge_service.py",
      "app.models",
      moduleToFile,
      firstPartyRoots,
    );
    expect(r.targets).toEqual(["app/models/__init__.py"]);
  });

  it("creates no edge for a stdlib / third-party import and does not record it", () => {
    const r = resolvePythonImport(
      "app/models/payment.py",
      "pydantic",
      moduleToFile,
      firstPartyRoots,
    );
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(false);
  });

  it("records an unresolvable first-party module rather than dropping it", () => {
    const r = resolvePythonImport(
      "app/services/charge_service.py",
      "app.models.missing",
      moduleToFile,
      firstPartyRoots,
    );
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(true);
  });
});

describe("go import resolution", () => {
  const files: F[] = [
    go("cmd/ledger/main.go", ["example.com/ledger/internal/payments"]),
    go("internal/payments/client.go", ["fmt"]),
    go("internal/payments/types.go", []),
    go("internal/ledger/ledger.go", ["example.com/ledger/internal/payments"]),
  ];
  const dirMap = buildGoDirMap(files);

  it("resolves a module import path to every file in the package directory", () => {
    const r = resolveGoImport("example.com/ledger/internal/payments", "example.com/ledger", dirMap);
    expect(new Set(r.targets)).toEqual(
      new Set(["internal/payments/client.go", "internal/payments/types.go"]),
    );
  });

  it("skips stdlib imports without recording them", () => {
    const r = resolveGoImport("fmt", "example.com/ledger", dirMap);
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(false);
  });

  it("skips external module imports (no edges into dependencies)", () => {
    const r = resolveGoImport("github.com/other/pkg", "example.com/ledger", dirMap);
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(false);
  });

  it("records an unresolvable first-party package path", () => {
    const r = resolveGoImport("example.com/ledger/internal/missing", "example.com/ledger", dirMap);
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(true);
  });
});

describe("java import resolution", () => {
  const files: F[] = [
    java("src/main/java/com/acme/settlement/payments/PaymentsClient.java", []),
    java("src/main/java/com/acme/settlement/payments/PaymentResponse.java", []),
    java("src/main/java/com/acme/settlement/charge/ChargeService.java", [
      "com.acme.settlement.payments.PaymentsClient",
    ]),
  ];
  const { fqnToFile, packageToFiles, firstPartyPackages } = buildJavaMaps(files);

  it("resolves a class import to its file", () => {
    const r = resolveJavaImport(
      "com.acme.settlement.payments.PaymentsClient",
      fqnToFile,
      packageToFiles,
      firstPartyPackages,
    );
    expect(r.targets).toEqual([
      "src/main/java/com/acme/settlement/payments/PaymentsClient.java",
    ]);
  });

  it("resolves a wildcard import to every class in the package", () => {
    const r = resolveJavaImport(
      "com.acme.settlement.payments.*",
      fqnToFile,
      packageToFiles,
      firstPartyPackages,
    );
    expect(new Set(r.targets)).toEqual(
      new Set([
        "src/main/java/com/acme/settlement/payments/PaymentsClient.java",
        "src/main/java/com/acme/settlement/payments/PaymentResponse.java",
      ]),
    );
  });

  it("skips java.* / external imports without recording them", () => {
    for (const spec of ["java.util.List", "org.springframework.stereotype.Service"]) {
      const r = resolveJavaImport(spec, fqnToFile, packageToFiles, firstPartyPackages);
      expect(r.targets).toEqual([]);
      expect(r.unresolved).toBe(false);
    }
  });

  it("records an unresolvable first-party class", () => {
    const r = resolveJavaImport(
      "com.acme.settlement.payments.DoesNotExist",
      fqnToFile,
      packageToFiles,
      firstPartyPackages,
    );
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toBe(true);
  });
});

describe("buildProviderReachability", () => {
  it("reaches files that import the anchor's package and its cohesion siblings (Go)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mp-go-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/ledger\n\ngo 1.22\n");
    try {
      const files: F[] = [
        go("internal/payments/client.go", ["fmt"]), // anchor (has the http path in reality)
        go("internal/payments/types.go", []), // sibling — reached via cohesion
        go("internal/ledger/ledger.go", ["example.com/ledger/internal/payments"]),
        go("internal/ledger/entry.go", []), // sibling of ledger.go — cohesion
        go("internal/build/assets.go", ["fmt"]), // unrelated package
      ];
      const { reachable } = buildProviderReachability(
        files,
        dir,
        ["internal/payments/client.go"],
      );
      expect(reachable.has("internal/ledger/ledger.go")).toBe(true); // imports the package
      expect(reachable.has("internal/payments/types.go")).toBe(true); // cohesion sibling of anchor
      expect(reachable.has("internal/ledger/entry.go")).toBe(true); // cohesion sibling of importer
      expect(reachable.has("internal/build/assets.go")).toBe(false); // unrelated package
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches a Java wildcard importer and same-package siblings, not unrelated packages", () => {
    const files: F[] = [
      java("src/main/java/com/acme/settlement/payments/PaymentResponse.java", []), // anchor
      java("src/main/java/com/acme/settlement/payments/PaymentsClient.java", []), // cohesion sibling
      java("src/main/java/com/acme/settlement/charge/ChargeService.java", [
        "com.acme.settlement.payments.*",
      ]),
      java("src/main/java/com/acme/settlement/charge/Charge.java", []), // cohesion sibling
      java("src/main/java/com/acme/settlement/asset/AssetManifest.java", []), // unrelated
    ];
    const { reachable } = buildProviderReachability(files, "/repo", [
      "src/main/java/com/acme/settlement/payments/PaymentResponse.java",
    ]);
    expect(reachable.has("src/main/java/com/acme/settlement/charge/ChargeService.java")).toBe(true);
    expect(reachable.has("src/main/java/com/acme/settlement/payments/PaymentsClient.java")).toBe(true);
    expect(reachable.has("src/main/java/com/acme/settlement/charge/Charge.java")).toBe(true);
    expect(reachable.has("src/main/java/com/acme/settlement/asset/AssetManifest.java")).toBe(false);
  });

  it("includes a Python upstream DTO module the anchor imports (one-hop dependency)", () => {
    const files: F[] = [
      py("app/providers/payments_client.py", ["app.models.payment"]), // anchor
      py("app/models/payment.py", ["pydantic"]), // upstream DTO, imported BY anchor
      py("app/services/charge_service.py", ["app.providers.payments_client"]),
      py("app/inventory/service.py", ["app.logging"]), // unrelated
    ];
    const { reachable } = buildProviderReachability(files, "/repo", [
      "app/providers/payments_client.py",
    ]);
    expect(reachable.has("app/services/charge_service.py")).toBe(true); // imports anchor
    expect(reachable.has("app/models/payment.py")).toBe(true); // one-hop dependency of anchor
    expect(reachable.has("app/inventory/service.py")).toBe(false); // unrelated
  });

  it("records unresolved first-party specifiers rather than dropping them silently", () => {
    const files: F[] = [
      py("app/main.py", ["app.does_not_exist", "os"]),
      py("app/__init__.py", []),
    ];
    const { unresolved } = buildProviderReachability(files, "/repo", []);
    expect(unresolved).toEqual([
      { fromFile: "app/main.py", spec: "app.does_not_exist", language: "python" },
    ]);
  });

  it("resolves a src-layout absolute import to root the same as flat layout (A/B)", () => {
    // Byte-identical Python source; the ONLY variable is the directory layout.
    // Flat layout (`app/...`) and src layout (`src/app/...`) must agree: an
    // absolute `app.client` import resolves in both, so provider provenance
    // reaches the same importer. The bug this fixes was that src-layout derived
    // `src` as the only first-party root, classing `app.client` as third-party
    // and building no edge, which silently demoted the importer and *raised*
    // overall confidence.
    const layout = (prefix: string): F[] => [
      py(`${prefix}app/__init__.py`, []),
      py(`${prefix}app/client.py`, []), // provider client = anchor
      py(`${prefix}app/orders.py`, ["app.client"]), // real edit site: imports the client
    ];

    // Direct resolution: the src-layout absolute import resolves to the client.
    const srcMaps = buildPythonModuleMaps(layout("src/"));
    const resolved = resolvePythonImport(
      "src/app/orders.py",
      "app.client",
      srcMaps.moduleToFile,
      srcMaps.firstPartyRoots,
      srcMaps.fileToModule,
    );
    expect(resolved.targets).toEqual(["src/app/client.py"]);
    expect(srcMaps.firstPartyRoots.has("app")).toBe(true);

    // Reachability agrees across layouts (module names are layout-independent).
    const flat = buildProviderReachability(layout(""), "/repo", ["app/client.py"]);
    const src = buildProviderReachability(layout("src/"), "/repo", ["src/app/client.py"]);
    const strip = (s: Set<string>) =>
      new Set([...s].map((p) => p.replace(/^src\//, "")));
    expect(strip(src.reachable)).toEqual(flat.reachable);
    expect(flat.reachable.has("app/orders.py")).toBe(true); // importer reached
    expect(src.reachable.has("src/app/orders.py")).toBe(true); // importer reached
    // Neither layout leaves the resolved first-party import recorded as unresolved.
    expect(flat.unresolved).toEqual([]);
    expect(src.unresolved).toEqual([]);
  });

  it("builds no import edges into a vendored / site-packages directory", () => {
    // Even if a dependency directory leaked into the file list, a bare
    // third-party specifier must not resolve to it.
    const files: F[] = [
      py("app/client.py", ["requests"]),
      py("app/__init__.py", []),
      py(".venv/lib/site-packages/requests/__init__.py", []),
    ];
    const { forward } = buildLanguageGraphs(files, "/repo");
    const edges = forward.get("app/client.py");
    expect(edges).toBeUndefined();
  });
});
