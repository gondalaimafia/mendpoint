import Link from "next/link";

export function PublicFooter() {
  return (
    <footer className="public-footer">
      <div>
        <strong>Mendpoint</strong>
        <span>Private Design Partner Preview</span>
      </div>
      <nav aria-label="Public footer">
        <Link href="/docs">Documentation</Link>
        <Link href="/security">Security</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/service-status">Status</Link>
        <Link href="/contact">Contact</Link>
        <Link href="/access">Product login</Link>
        <a href="https://github.com/gondalaimafia/mendpoint">GitHub</a>
      </nav>
    </footer>
  );
}
