export default function Loading() {
  return (
    <div className="workspace-page" aria-busy="true" aria-label="Loading workspace">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-copy" />
      <div className="metric-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="metric-card" key={index}>
            <div className="skeleton skeleton-label" />
            <div className="skeleton skeleton-value" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading Mendpoint workspace</span>
    </div>
  );
}
