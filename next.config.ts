import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
