import type { NextConfig } from "next";

/**
 * GitHub Codespaces forwards the app through "<codespace>-3000.<domain>". Server
 * Actions reject a browser Origin that differs from the server's host, so in a
 * Codespace (and only there) allow exactly this Codespace's own forwarded host —
 * no wildcard. Render never sets these variables, so production is unchanged.
 */
const codespaceHost =
  process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : null;

const nextConfig: NextConfig = {
  cacheComponents: true,
  ...(codespaceHost ? { experimental: { serverActions: { allowedOrigins: [codespaceHost] } } } : {}),
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
