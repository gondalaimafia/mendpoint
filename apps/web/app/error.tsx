"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="workspace-page">
      <section className="surface problem-state" role="alert">
        <p className="eyebrow">Workspace unavailable</p>
        <h1>Mendpoint could not load this view</h1>
        <p>The operation is safe. Retry the request or open system status for more detail.</p>
        <div className="btn-row">
          <button className="primary" type="button" onClick={reset}>Retry</button>
          <a className="btn" href="/status">Open system status</a>
        </div>
      </section>
    </div>
  );
}
