export default function TrustPage() {
  return (
    <div className="prose">
      <h1>Trust model</h1>
      <p>
        Codebase access is the highest-stakes permission. Every design choice optimizes for a careful
        engineering team being more willing to install the agent.
      </p>
      <h2>Defaults</h2>
      <ul>
        <li>
          <strong>PR only</strong> — never direct commits to protected branches.
        </li>
        <li>
          <strong>Mock GitHub mode</strong> offline by default (<code>GITHUB_MODE=mock</code>).
        </li>
        <li>
          <strong>Precision over recall</strong> — low-confidence impacts do not auto-open confident PRs.
        </li>
        <li>
          <strong>Full audit trail</strong> — analysis and delivery steps are logged.
        </li>
        <li>
          <strong>No training on your code</strong> without explicit opt-in.
        </li>
      </ul>
      <h2>Permissions (target GitHub App)</h2>
      <ul>
        <li>Read repository contents</li>
        <li>Create branches and pull requests</li>
        <li>No admin, no secrets, no force-push</li>
      </ul>
      <h2>Enterprise path</h2>
      <p>
        Self-hosted runners, private model endpoints, and SOC 2 evidence export are on the roadmap —
        not required for the local MVP scaffold.
      </p>
    </div>
  );
}
