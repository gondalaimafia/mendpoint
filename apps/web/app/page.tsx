import Link from "next/link";

export default function HomePage() {
  return (
    <div>
      <h1>Mendpoint · Design partner pilot</h1>
      <p className="lead">
        Live API change intelligence: OpenAPI diff → graph impact →{" "}
        <strong>review first migration pull requests</strong>, plus Warden on demand debug.
        Humans review. Nothing touches <code>main</code> by default.
      </p>
      <p className="muted small">
        Stage <strong>Design partner</strong> ·{" "}
        <Link href="/status">System status</Link>
      </p>
      <div className="hero-actions">
        <Link className="btn primary" href="/provider">
          Provider dashboard
        </Link>
        <Link className="btn" href="/consumer">
          Consumer dashboard
        </Link>
        <Link className="btn" href="/agent">
          Warden agent
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
            Blast radius via call graph:{" "}
            <Link href="/graph">explore the graph</Link>.
          </p>
        </div>
        <div className="card">
          <h3>3. Review, not silent write</h3>
          <p className="muted">
            Verified changes are packaged as draft pull requests when a customer repository is
            connected.
          </p>
        </div>
      </div>
    </div>
  );
}
