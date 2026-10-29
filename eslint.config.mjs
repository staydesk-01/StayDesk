import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Server code (API logic, tools, tests) is plain TypeScript: allow deliberate `any` at framework boundaries.
    files: ["server/**", "tests/**", "lib/mongodb.ts", "instrumentation.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  globalIgnores(["staydesk-voice-agent/**", ".next-build/**", ".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts"]),
]);

export default eslintConfig;
