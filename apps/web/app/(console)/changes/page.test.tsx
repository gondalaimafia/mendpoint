import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ChangesView uses next/link; stub it so the returned element renders in node.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => React.createElement("a", { href, ...rest }, children),
}));

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../../../lib/api", () => ({ apiGet }));

import ChangesPage from "./page";

const CHANGE_LIST_ITEM = {
  id: "chg1",
  providerId: "prov1",
  fromVersionId: null,
  toVersionId: null,
  risk: "breaking",
  summary: "charge() removed",
  severity: "high",
  diffJson: "",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PROVIDER = {
  id: "prov1",
  slug: "payments",
  name: "Payments",
  website: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("/changes page — a failed change-detail fetch is unknown, not empty", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("renders the honest 'Changes unavailable' state when /changes/:id rejects", async () => {
    // The list + providers resolve (there IS a real breaking change), but the
    // detail fetch rejects (500 or 12s timeout). The page must not build a
    // non-null ChangesData with changes:[] — that renders "No structural change
    // is staged yet" under the real provider title, telling an operator the diff
    // is empty and zero repos are affected when the fetch simply failed.
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/changes") return [CHANGE_LIST_ITEM];
      if (path === "/providers") return [PROVIDER];
      if (path === "/changes/chg1") throw new Error("API /changes/chg1 returned 500");
      if (path === "/providers/payments") return { ...PROVIDER, versions: [] };
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await ChangesPage());

    expect(html).toContain("Changes unavailable");
    expect(html).toContain("not a claim that the spec is unchanged");
    expect(html).not.toContain("No structural change is staged yet");
  });

  it("still renders the real diff when the detail fetch resolves", async () => {
    // Positive control: the unavailable state is driven by the rejection, not by
    // always returning null.
    apiGet.mockImplementation(async (path: string) => {
      if (path === "/changes") return [CHANGE_LIST_ITEM];
      if (path === "/providers") return [PROVIDER];
      if (path === "/changes/chg1") {
        return {
          ...CHANGE_LIST_ITEM,
          diff: {
            entries: [
              { op: "method_removed", method: "post", path: "/v1/charges", breaking: true },
            ],
            risk: "breaking",
            summary: "charge() removed",
          },
          findings: [],
          prs: [],
        };
      }
      if (path === "/providers/payments") return { ...PROVIDER, versions: [] };
      throw new Error(`unexpected ${path}`);
    });

    const html = renderToStaticMarkup(await ChangesPage());

    expect(html).toContain("POST /v1/charges");
    expect(html).not.toContain("Changes unavailable");
    expect(html).not.toContain("No structural change is staged yet");
  });
});
