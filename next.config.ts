import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

/**
 * Deployment identifier, fixed at BUILD time and baked into both the browser bundle and the server bundle, so the
 * "version this tab loaded" and "version the server reports" are comparable and change on every deployment.
 * Uses the platform's commit SHA / deployment id when present, else APP_BUILD_ID, else a unique per-build stamp.
 */
const buildId =
  process.env.APP_BUILD_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RAILWAY_DEPLOYMENT_ID ||
  process.env.SOURCE_VERSION ||
  `build-${Date.now().toString(36)}`;
const appVersion = (JSON.parse(readFileSync(`${__dirname}/package.json`, "utf8")) as { version: string }).version;

const nextConfig: NextConfig = {
  // Optional: build into a different folder (lets a production build run next to a dev server).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  generateBuildId: async () => buildId,
  env: { NEXT_PUBLIC_BUILD_ID: buildId, NEXT_PUBLIC_APP_VERSION: appVersion },
  turbopack: { root: __dirname },
  // Server-only libraries that should not be bundled.
  serverExternalPackages: ["mongoose", "twilio", "bcryptjs", "jsonwebtoken", "openai", "resend"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
