import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildDocsManifest,
  docsByCategory,
  findProductDoc,
  PRODUCT_DOCS,
  renderProductDocMarkdown,
  type ProductDoc,
} from "../apps/web/app/docs/catalog.js";

const OUTPUT = resolve(process.cwd(), "docs", "website-upload");
const OUTPUT_OWNER = ".mendpoint-public-docs-owner";
const OUTPUT_OWNER_TOKEN = "Mendpoint public documentation bundle";
const OUTPUT_OWNER_CONTENT = `${OUTPUT_OWNER_TOKEN}\n`;

export function buildPublicDocsBundle(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  files.set("styles.css", uploadStyles());
  files.set("manifest.json", `${JSON.stringify(buildDocsManifest(), null, 2)}\n`);
  files.set("index.html", renderIndex());
  for (const page of PRODUCT_DOCS) {
    files.set(`${page.slug}.html`, renderPage(page));
    files.set(`${page.slug}.md`, renderProductDocMarkdown(page));
  }
  return files;
}

export async function writePublicDocsBundle(
  check = false,
  output = OUTPUT,
): Promise<void> {
  const files = buildPublicDocsBundle();
  if (!check) await mkdir(output, { recursive: true });
  const entries = await readOutputEntries(output);
  await requireOutputOwnership(output, entries, check);
  const expected = new Set([...files.keys(), OUTPUT_OWNER]);
  const unexpectedFiles = entries
    .filter((entry) => entry.isFile() && !expected.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const unexpectedEntries = entries
    .filter((entry) => !entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (unexpectedEntries.length > 0) {
    throw new Error(`public_docs_bundle_unexpected_entries:${unexpectedEntries.join(",")}`);
  }
  if (check && unexpectedFiles.length > 0) {
    throw new Error(`public_docs_bundle_unexpected_files:${unexpectedFiles.join(",")}`);
  }
  if (!check) {
    for (const name of unexpectedFiles) await unlink(outputPath(output, name));
  }
  const mismatches: string[] = [];
  for (const [name, content] of files) {
    const target = outputPath(output, name);
    if (check) {
      try {
        if (await readFile(target, "utf8") !== content) mismatches.push(name);
      } catch { mismatches.push(name); }
    } else {
      await writeFile(target, content, "utf8");
    }
  }
  if (mismatches.length) throw new Error(`public_docs_bundle_out_of_date:${mismatches.join(",")}`);
}

async function requireOutputOwnership(
  output: string,
  entries: Awaited<ReturnType<typeof readOutputEntries>>,
  check: boolean,
): Promise<void> {
  const owner = entries.find((entry) => entry.name === OUTPUT_OWNER);
  if (owner) {
    if (!owner.isFile()) throw new Error(`public_docs_bundle_owner_invalid:${output}`);
    const content = await readFile(outputPath(output, OUTPUT_OWNER), "utf8");
    if (![OUTPUT_OWNER_TOKEN, `${OUTPUT_OWNER_TOKEN}\n`, `${OUTPUT_OWNER_TOKEN}\r\n`].includes(content)) {
      throw new Error(`public_docs_bundle_owner_invalid:${output}`);
    }
    return;
  }
  if (entries.length > 0 || check) {
    throw new Error(`public_docs_bundle_owner_missing:${output}`);
  }
  await writeFile(outputPath(output, OUTPUT_OWNER), OUTPUT_OWNER_CONTENT, "utf8");
}

async function readOutputEntries(output: string) {
  try {
    return await readdir(output, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function outputPath(output: string, name: string): string {
  const root = resolve(output);
  const target = resolve(root, name);
  const locator = relative(root, target);
  if (locator.startsWith("..") || isAbsolute(locator)) {
    throw new Error(`public_docs_bundle_path_escape:${name}`);
  }
  return target;
}

function renderIndex(): string {
  const groups = docsByCategory().map(({ category, pages }) => `
    <section>
      <h2>${html(category)}</h2>
      <div class="cards">${pages.map((page) => `
        <a class="card" href="${attribute(page.slug)}.html">
          <span class="status">${html(page.statusLabel)}</span>
          <h3>${html(page.title)}</h3>
          <p>${html(page.summary)}</p>
        </a>`).join("")}
      </div>
    </section>`).join("");
  return document("Mendpoint documentation", `
    <header class="hero">
      <p class="kicker">Mendpoint documentation</p>
      <h1>Build safe software migration workflows</h1>
      <p>Understand change, produce bounded candidates, verify the result, and deliver it for human review.</p>
      <pre><code>npm install\nnpm run demo</code></pre>
    </header>
${groups}
    <section><h2>Machine-readable resources</h2><p>Every component is included beside this page as Markdown. Use <a href="manifest.json">manifest.json</a> to enumerate the bundle.</p></section>`);
}

function renderPage(page: ProductDoc): string {
  const related = page.related.map((slug) => {
    const item = findProductDoc(slug);
    return item ? `<li><a href="${attribute(slug)}.html">${html(item.title)}</a></li>` : "";
  }).join("");
  return document(page.title, `
    <nav class="crumb"><a href="index.html">Documentation</a> / ${html(page.category)}</nav>
    <header class="hero">
      <p class="kicker">${html(page.category)}</p>
      <h1>${html(page.title)}</h1>
      <p>${html(page.summary)}</p>
      <dl><dt>Status</dt><dd>${html(page.statusLabel)}</dd><dt>Availability</dt><dd>${html(page.availability)}</dd><dt>Last verified</dt><dd>${html(page.lastVerified)}</dd></dl>
    </header>
    ${section("Start here", `<p>${html(page.startHere.intro)}</p>${ordered(page.startHere.steps)}${page.startHere.command ? `<pre><code>${html(page.startHere.command)}</code></pre>` : ""}`)}
    ${section("What it does", unordered(page.capabilities))}
    ${section("When to use it", unordered(page.useWhen))}
    ${section("How it works", ordered(page.howItWorks))}
    ${section("Interfaces", `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Description</th></tr></thead><tbody>${page.interfaces.map((item) => `<tr><td><code>${html(item.name)}</code></td><td>${html(item.kind)}</td><td>${html(item.detail)}</td></tr>`).join("")}</tbody></table></div>`)}
    ${section("Evidence and verification", `<ul>${page.evidence.map((item) => `<li><strong>${html(item.label)}</strong><br><code>${html(item.locator)}</code></li>`).join("")}</ul>`)}
    ${section("Safety model", unordered(page.guardrails, "guardrails"))}
    ${section("Limitations", unordered(page.limitations))}
    ${section("See also", `<ul>${related}</ul>`)}
    <p class="download"><a href="${attribute(page.slug)}.md">Read this page as Markdown</a></p>`);
}

function document(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${html(title)} | Mendpoint</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header class="top"><a href="index.html">Mendpoint</a><span>Product documentation</span></header>
  <main id="content">${content}</main>
  <footer>Evidence-backed migration software. Human review remains required for delivered code.</footer>
</body>
</html>
`;
}

function section(title: string, body: string): string { return `<section><h2>${html(title)}</h2>${body}</section>`; }
function ordered(items: readonly string[]): string { return `<ol>${items.map((item) => `<li>${html(item)}</li>`).join("")}</ol>`; }
function unordered(items: readonly string[], className = ""): string { return `<ul${className ? ` class="${attribute(className)}"` : ""}>${items.map((item) => `<li>${html(item)}</li>`).join("")}</ul>`; }
function html(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function attribute(value: string): string { return html(value.replaceAll("`", "")); }

function uploadStyles(): string {
  return `:root{color-scheme:dark;--bg:#080b18;--panel:#101526;--border:#293047;--text:#f2f4f8;--muted:#9aa3b7;--accent:#7698ff;--ok:#22c55e}*{box-sizing:border-box}html{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.55}body{margin:0}.top{display:flex;justify-content:space-between;gap:1rem;padding:1rem clamp(1rem,4vw,3rem);border-bottom:1px solid var(--border)}.top a,a{color:var(--accent)}main,footer{width:min(100% - 2rem,980px);margin:auto}main{padding:3rem 0}footer{padding:2rem 0 3rem;border-top:1px solid var(--border);color:var(--muted)}h1{font-size:clamp(2.5rem,7vw,5rem);line-height:.98;letter-spacing:-.055em}h2{margin-top:0}h3{margin:.5rem 0}p,li,dd{color:var(--muted)}section{padding:1.6rem 0;border-bottom:1px solid var(--border)}pre{padding:1rem;overflow:auto;border:1px solid var(--border);border-radius:.7rem;background:var(--panel)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.hero{padding-bottom:2rem}.kicker,.status,.crumb,.download{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}.kicker{color:var(--accent);text-transform:uppercase;letter-spacing:.1em}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:.8rem}.card{display:block;min-height:210px;padding:1.2rem;border:1px solid var(--border);border-radius:.8rem;background:var(--panel);color:var(--text);text-decoration:none}.card:hover{border-color:var(--accent)}.status{color:var(--ok)}dl{display:grid;grid-template-columns:120px 1fr;gap:.5rem}dt{color:var(--muted)}dd{margin:0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:.7rem;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}.guardrails{padding:1rem 1rem 1rem 2.2rem;border:1px solid var(--accent);border-radius:.7rem;background:var(--panel)}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:var(--panel);padding:.5rem}.crumb{color:var(--muted)}@media(max-width:600px){main,footer{width:min(100% - 1.25rem,980px)}main{padding-top:1.5rem}dl{grid-template-columns:1fr;gap:.2rem}}
`;
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  void writePublicDocsBundle(check)
    .then(() => console.log(check ? "Public docs bundle is current" : `Public docs bundle written to ${OUTPUT}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "public_docs_bundle_failed");
      process.exitCode = 1;
    });
}
