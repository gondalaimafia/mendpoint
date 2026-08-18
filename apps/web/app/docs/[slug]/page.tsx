import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicFooter } from "../../public-footer";
import { docsByCategory, findProductDoc, PRODUCT_DOCS, type ProductDoc } from "../catalog.js";

type PageInput = Readonly<{ params: Promise<{ slug: string }> }>;

export const dynamicParams = false;

export function generateStaticParams() {
  return PRODUCT_DOCS.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: PageInput): Promise<Metadata> {
  const page = findProductDoc((await params).slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.summary,
    alternates: { canonical: `/docs/${page.slug}` },
  };
}

export default async function ProductDocumentationPage({ params }: PageInput) {
  const page = findProductDoc((await params).slug);
  if (!page) notFound();
  return (
    <div className="public-page docs-layout">
      <DocsSidebar current={page.slug} />
      <article className="docs-article">
        <header>
          <p className="public-kicker">{page.category}</p>
          <h1>{page.title}</h1>
          <p className="public-lead">{page.summary}</p>
          <dl className="docs-meta">
            <div><dt>Status</dt><dd><span className={`docs-status docs-status-${page.status}`}>{page.statusLabel}</span></dd></div>
            <div><dt>Availability</dt><dd>{page.availability}</dd></div>
            <div><dt>Last verified</dt><dd>{page.lastVerified}</dd></div>
          </dl>
        </header>

        <DocSection id="start-here" title="Start here">
          <p>{page.startHere.intro}</p>
          <ol>{page.startHere.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          {page.startHere.command ? <pre><code>{page.startHere.command}</code></pre> : null}
        </DocSection>
        <ListSection id="what-it-does" title="What it does" items={page.capabilities} />
        <ListSection id="when-to-use" title="When to use it" items={page.useWhen} />
        <DocSection id="how-it-works" title="How it works">
          <ol>{page.howItWorks.map((step) => <li key={step}>{step}</li>)}</ol>
        </DocSection>
        <DocSection id="interfaces" title="Interfaces">
          <div className="docs-table-wrap">
            <table aria-label={`${page.title} interfaces`} tabIndex={0}><thead><tr><th>Name</th><th>Kind</th><th>Description</th></tr></thead>
              <tbody>{page.interfaces.map((item) => <tr key={`${item.kind}:${item.name}`}><td><code>{item.name}</code></td><td>{item.kind}</td><td>{item.detail}</td></tr>)}</tbody>
            </table>
          </div>
        </DocSection>
        <DocSection id="evidence" title="Evidence and verification">
          <ul>{page.evidence.map((item) => <li key={item.locator}><strong>{item.label}</strong><br /><code>{item.locator}</code></li>)}</ul>
        </DocSection>
        <ListSection id="safety" title="Safety model" items={page.guardrails} emphasis />
        <ListSection id="limitations" title="Limitations" items={page.limitations} />
        <DocSection id="see-also" title="See also">
          <ul>{page.related.map((slug) => { const related = findProductDoc(slug); return related ? <li key={slug}><Link href={`/docs/${slug}`}>{related.title}</Link></li> : null; })}</ul>
        </DocSection>
        <div className="docs-download"><Link href={`/docs/${page.slug}.md`}>Read this page as Markdown</Link></div>
        <PublicFooter />
      </article>
      <OnThisPage page={page} />
    </div>
  );
}

function DocsSidebar({ current }: { current: string }) {
  return <aside className="docs-sidebar" aria-label="Documentation navigation"><Link className="docs-back" href="/docs">Documentation home</Link>{docsByCategory().map(({ category, pages }) => <div key={category}><h2>{category}</h2><ul>{pages.map((page) => <li key={page.slug}><Link aria-current={page.slug === current ? "page" : undefined} className={page.slug === current ? "active" : undefined} href={`/docs/${page.slug}`}>{page.title}</Link></li>)}</ul></div>)}</aside>;
}

function OnThisPage({ page }: { page: ProductDoc }) {
  const links = [["start-here", "Start here"], ["what-it-does", "What it does"], ["when-to-use", "When to use"], ["how-it-works", "How it works"], ["interfaces", "Interfaces"], ["evidence", "Evidence"], ["safety", "Safety model"], ["limitations", "Limitations"]] as const;
  return <aside className="docs-toc" aria-label={`On this page: ${page.title}`}><strong>On this page</strong><ul>{links.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul></aside>;
}

function DocSection({ id, title, children }: Readonly<{ id: string; title: string; children: React.ReactNode }>) {
  return <section id={id}><h2>{title}</h2>{children}</section>;
}

function ListSection({ id, title, items, emphasis = false }: Readonly<{ id: string; title: string; items: readonly string[]; emphasis?: boolean }>) {
  return <DocSection id={id} title={title}><ul className={emphasis ? "docs-guardrails" : undefined}>{items.map((item) => <li key={item}>{item}</li>)}</ul></DocSection>;
}
