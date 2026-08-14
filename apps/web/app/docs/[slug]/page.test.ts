import { describe, expect, it } from "vitest";
import * as productDocumentationPage from "./page.js";

describe("product documentation dynamic route", () => {
  it("rejects slugs outside the canonical static catalog", () => {
    expect(productDocumentationPage).toMatchObject({ dynamicParams: false });
    expect(productDocumentationPage.generateStaticParams()).toEqual(
      expect.arrayContaining([{ slug: "fettler" }, { slug: "regauge" }]),
    );
  });
});
