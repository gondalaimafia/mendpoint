import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "./nav";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.mendpoint.ai"),
  title: {
    default: "Mendpoint: Evidence backed API migration candidates",
    template: "%s | Mendpoint",
  },
  description: "Private design partner preview for supported GitHub repository migration workflows.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Mendpoint",
    title: "Mendpoint: Evidence backed API migration candidates",
    description: "Private design partner preview for supported GitHub repository migration workflows.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mendpoint: Evidence backed API migration candidates",
    description: "Private design partner preview for supported GitHub repository migration workflows.",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="app-shell">
          <Nav />
          <main id="main" className="app-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
