import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { AppChrome } from "./app-chrome";

const inter = Inter({ display: "swap", subsets: ["latin"], variable: "--font-inter" });
const sora = Sora({ display: "swap", subsets: ["latin"], variable: "--font-sora" });
const jetBrainsMono = JetBrains_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

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
    <html lang="en" className={`${inter.variable} ${sora.variable} ${jetBrainsMono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
