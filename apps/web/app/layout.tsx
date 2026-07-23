import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "./nav";

export const metadata: Metadata = {
  title: "Mendpoint",
  description: "Mendpoint — structured API change intelligence to migration PRs",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Nav />
        <main id="main" className="container">
          {children}
        </main>
      </body>
    </html>
  );
}
