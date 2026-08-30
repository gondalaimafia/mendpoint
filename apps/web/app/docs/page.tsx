import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter } from "../public-footer";
import { docsByCategory, PRODUCT_DOCS } from "./catalog.js";

export const metadata: Metadata = {
  title: "Product documentation",
  description: "Build and operate Mendpoint with evidence-backed guides for Fettler, ReGauge, change intelligence, delivery, verification, AI infrastructure, and production operations.",
  alternates: { canonical: "/docs" },
};

export default function DocumentationPage() {
  return (
    <div className="public-page docs-hub">
      <header className="docs-hero">
        <p className="public-kicker">Mendpoint documentation</p>
        <h1>Build safe software migration workflows</h1>
        <p className="public-lead">
          Start with an exact repository snapshot, understand the change, produce a bounded candidate,
          verify it, and deliver it for human review.
        </p>
        <p className="public-lead">
          Fettler — the first AI API Engineer. ReGauge — the first AI Legacy Engineer.
        </p>
        <div className="public-actions">
          <Link className="btn primary" href="/docs/fettler">Start with Fettler</Link>
          <Link className="btn" href="/docs/regauge">Plan a ReGauge campaign</Link>
        </div>
      </header>

      <section className="docs-start" aria-labelledby="docs-start-title">
        <div>
          <p className="public-kicker">Start here</p>
          <h2 id="docs-start-title">Run the local evidence-backed demo</h2>
          <p>Use synthetic fixtures and mock source control. No external account is required.</p>
        </div>
        <pre aria-label="Quickstart command"><code>npm install{"\n"}npm run demo</code></pre>
      </section>

      {docsByCategory().map(({ category, pages }) => (
        <section className="docs-group" key={category} aria-labelledby={`category-${category.replaceAll(" ", "-").toLowerCase()}`}>
          <h2 id={`category-${category.replaceAll(" ", "-").toLowerCase()}`}>{category}</h2>
          <div className="docs-card-grid">
            {pages.map((page) => (
              <Link className="docs-card" href={`/docs/${page.slug}`} key={page.slug}>
                <span className={`docs-status docs-status-${page.status}`}>{page.statusLabel}</span>
                <h3>{page.title}</h3>
                <p>{page.summary}</p>
                <span className="docs-card-link">Read the guide</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <section className="docs-machine" aria-labelledby="machine-readable-title">
        <div>
          <p className="public-kicker">Machine-readable resources</p>
          <h2 id="machine-readable-title">The same documentation for coding agents</h2>
          <p>Append <code>.md</code> to any component guide, or use the manifest to enumerate every page.</p>
        </div>
        <ul className="public-list">
          <li><Link href="/docs/fettler.md">Fettler as Markdown</Link></li>
          <li><Link href="/docs/regauge.md">ReGauge as Markdown</Link></li>
          <li><Link href="/docs/manifest.json">Documentation manifest</Link></li>
        </ul>
      </section>

      <p className="docs-count">{PRODUCT_DOCS.length} component guides, generated from one evidence-backed catalog.</p>
      <PublicFooter />
    </div>
  );
}
