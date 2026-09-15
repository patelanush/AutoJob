import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "node_modules/**",
      "private/**",
      "data/**",
      "dist/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["src/ats/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: ["playwright", "@playwright/test"] },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(click|press|evaluate|dispatchEvent)$/]",
          message: "Adapters must use the guarded BrowserActions interface.",
        },
      ],
    },
  },
);
