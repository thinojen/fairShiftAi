import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // App code must reach PayPal only through the server-only entry point,
    // so credentials can never be bundled into the browser.
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@/lib/paypal/(?!server$)",
              message: "Import PayPal code from @/lib/paypal/server only.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  {
    // Must come AFTER the app-wide block: a later no-restricted-imports replaces an earlier one.
    // The AI assistant and pay queries must never be able to reach PayPal.
    files: ["lib/assistant/**/*.ts", "lib/payqueries/**/*.ts", "lib/worker/**/*.ts", "app/api/assistant/**/*.ts", "app/payquery-actions.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "(^|/)paypal(/|$)", message: "AI and pay-query code must not import PayPal modules." },
            { regex: "(^|/)payouts(/|$)", message: "AI and pay-query code must not import payout modules." },
            { regex: "^@/lib/paypal/(?!server$)", message: "Import PayPal code from @/lib/paypal/server only." },
          ],
        },
      ],
    },
  },
  {
    // Browser components must never import AI provider code (API keys live server-side).
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^@/lib/paypal/(?!server$)", message: "Import PayPal code from @/lib/paypal/server only." },
            { regex: "^@/lib/assistant/(providers|server|limits|run|tools)", message: "Client components must not import AI provider/runtime code." },
          ],
        },
      ],
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
