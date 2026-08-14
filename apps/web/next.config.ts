import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // The design-system components (app/components/ds, app/components/console) use
  // NodeNext-style `.js` import specifiers that point at `.ts`/`.tsx` sources.
  // tsc (moduleResolution: bundler) and Vitest resolve these already; teach the
  // production webpack resolver the same mapping so those modules bundle.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
  async redirects() {
    return [
      { source: "/contact", destination: "/design-partners", permanent: false },
      { source: "/login", destination: "/access", permanent: false },
      { source: "/docs/warden", destination: "/docs/fettler", permanent: true },
      { source: "/docs/warden.md", destination: "/docs/fettler.md", permanent: true },
      { source: "/docs/transformer", destination: "/docs/regauge", permanent: true },
      { source: "/docs/transformer.md", destination: "/docs/regauge.md", permanent: true },
    ];
  },
  async headers() {
    // Next.js dev mode (HMR / React Refresh) evaluates strings as JavaScript,
    // which a strict production CSP forbids, so the dev server never hydrates.
    // Allow 'unsafe-eval' ONLY in development; production stays strict.
    const scriptSrc =
      process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; ${scriptSrc}; style-src 'self' 'unsafe-inline'`,
          },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
