import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const [tool, ...args] = process.argv.slice(2);
const bins = {
  cli: "tsx/dist/cli.mjs",
  vitest: "vitest/vitest.mjs",
  playwright: "@playwright/test/cli.js",
  tsc: "typescript/bin/tsc",
  eslint: "eslint/bin/eslint.js",
  prettier: "prettier/bin/prettier.cjs",
  vite: "vite/bin/vite.js",
};
const local = resolve("node_modules/node/bin/node");
const executable = existsSync(local) ? local : process.execPath;
const child = spawn(
  executable,
  [
    ...(tool === "cli"
      ? ["--import", "tsx", "src/cli/index.ts"]
      : [resolve("node_modules", bins[tool])]),
    ...args,
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => {
  console.error("Install dependencies with npm install first.");
  process.exit(1);
});
