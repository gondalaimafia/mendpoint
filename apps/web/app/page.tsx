import Link from "next/link";

export default function HomePage() {
  return (
    <div>
      <h1>Mendpoint</h1>
      <p className="lead">
        When providers ship breaking changes or high-value capabilities, Mendpoint scans
        connected codebases and opens migration PRs. Humans review. Nothing touches{" "}
        <code>main</code> by default.
      </p>
      <div className="hero-actions">
        <Link className="btn primary" href="/provider">
          Provider dashboard
        </Link>
        <Link className="btn" href="/consumer">
          Consumer dashboard
        </Link>
        <Link className="btn" href="/trust">
          Trust model
        </Link>
      </div>
      <div className="grid">
        <div className="card">
          <h3>1. Structured change</h3>
          <p className="muted">OpenAPI diffs classify breaking vs additive changes as a graph.</p>
        </div>
        <div className="card">
          <h3>2. Graph impact</h3>
          <p className="muted">
            Blast radius via call graph —{" "}
            <Link href="/graph">explore the graph</Link>.
          </p>
        </div>
        <div className="card">
          <h3>3. PR, not silent write</h3>
          <p className="muted">Generated patches open as PRs with risk, evidence, and audit.</p>
        </div>
      </div>
    </div>
  );
}
