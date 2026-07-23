import { apiGet } from "../../lib/api";
import { BrandPreview } from "./preview";

type Pack = {
  id: string;
  providerSlug: string;
  displayName: string;
  tagline: string;
  accentColor: string;
  prTitlePrefix: string;
  installCta: string;
  labels: string[];
  requiresPlan: string;
  docsUrl?: string;
};

export default async function BrandsPage() {
  let packs: Pack[] = [];
  let error: string | null = null;
  try {
    packs = await apiGet<Pack[]>("/brands");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="page">
      <div className="page-header">
        <h1>First-party agents</h1>
        <p className="muted">
          Provider-native packaging over the Mendpoint core — e.g. &quot;Install Stripe&apos;s Update
          Agent&quot;. Same pipeline, branded PR titles and footers.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      )}

      <div className="grid">
        {packs.map((p) => (
          <div className="card" key={p.id} style={{ borderTop: `3px solid ${p.accentColor}` }}>
            <h3>{p.displayName}</h3>
            <p className="muted">{p.tagline}</p>
            <p className="small">
              Provider <code>{p.providerSlug}</code> · plan <code>{p.requiresPlan}+</code>
            </p>
            <p className="mono small">{p.prTitlePrefix}</p>
            <p className="muted small">Labels: {p.labels.join(", ")}</p>
            {p.docsUrl && (
              <p className="small">
                <a href={p.docsUrl} target="_blank" rel="noreferrer">
                  Docs
                </a>
              </p>
            )}
            <BrandPreview packId={p.id} cta={p.installCta} />
          </div>
        ))}
      </div>
    </main>
  );
}
