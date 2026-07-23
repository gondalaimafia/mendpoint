import { apiGet } from "../../lib/api";
import { InstallWizard } from "./wizard";

type AppConfig = {
  appId: string | null;
  appSlug: string;
  appName: string;
  configured: boolean;
  mockMode: boolean;
  permissions: Record<string, string>;
  events: string[];
};

type Installation = {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  updatedAt: string;
};

export default async function InstallPage() {
  let config: AppConfig | null = null;
  let installations: Installation[] = [];
  let error: string | null = null;
  try {
    config = await apiGet<AppConfig>("/github/app/config");
    installations = await apiGet<Installation[]>("/github/app/installations");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="page">
      <div className="page-header">
        <h1>Install Mendpoint</h1>
        <p className="muted">
          GitHub App install wizard — connect an org or user so Mendpoint can open migration PRs.
          Never auto-merges.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">API offline: {error}</p>
        </div>
      )}

      {config && <InstallWizard config={config} initialInstallations={installations} />}

      <section className="card">
        <h2>Existing installations</h2>
        {installations.length === 0 ? (
          <p className="muted">None yet — complete the wizard above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Installation ID</th>
                <th>Type</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {installations.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.accountLogin}</strong>
                  </td>
                  <td className="mono">{i.installationId}</td>
                  <td>{i.accountType}</td>
                  <td className="mono">{new Date(i.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
