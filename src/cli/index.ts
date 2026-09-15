import { Command } from "commander";
import { existsSync, chmodSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import {
  paths,
  root,
  setupProfile,
  loadProfile,
  directories,
} from "../config/profile.js";
import { Store } from "../db/store.js";
import { fetchFeed, parseFeed, eligible } from "../feed/parser.js";
import { checkGitSafety } from "../security/privacy.js";
import { Keychain, promptSecret } from "../security/keychain.js";
import { GmailVerification } from "../verification/gmail.js";
import { extractResume } from "../llm/context.js";
const base = "http://127.0.0.1:4317";
const program = new Command()
  .name("job-apply-agent")
  .description("Prepare applications locally. Final submission is human-only.");
async function api(path: string, body?: unknown) {
  const session = await fetch(base + "/api/session");
  if (!session.ok) throw new Error("Runtime unavailable");
  const { csrf } = (await session.json()) as { csrf: string };
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      "x-csrf-token": csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data as { error: string }).error);
  return data;
}
async function open(url: string) {
  await new Promise<void>((ok, no) =>
    execFile("/usr/bin/open", [url], (e) => (e ? no(e) : ok())),
  );
}
async function running() {
  try {
    await api("/api/status");
    return true;
  } catch {
    return false;
  }
}
async function serve() {
  checkGitSafety();
  const { Runtime, acquireLock } = await import("../runs/runtime.js");
  directories();
  const release = acquireLock();
  let runtime: InstanceType<typeof Runtime>;
  try {
    runtime = new Runtime();
  } catch (e) {
    release();
    throw e;
  }
  const { createAPI } = await import("./server.js");
  const app = await createAPI(runtime);
  try {
    await app.listen({ host: "127.0.0.1", port: 4317 });
  } catch (e) {
    await runtime.shutdown();
    release();
    throw e;
  }
  console.log(`Dashboard: ${base}`);
  const timer = setInterval(
    () =>
      void runtime.sessions
        .observe((id) => runtime.submitted(id))
        .catch(() => undefined),
    3000,
  );
  const heartbeat = setInterval(() => {
    if (runtime.busy)
      runtime.store.sqlite
        .prepare(
          "UPDATE application_attempts SET last_heartbeat_at = ? WHERE finished_at IS NULL",
        )
        .run(new Date().toISOString());
  }, 10000);
  const stop = async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    await app.close();
    await runtime.shutdown();
    release();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return runtime;
}
async function ensureRuntime() {
  if (await running()) return;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", "serve"],
    { cwd: root, stdio: "inherit" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await running()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    "Runtime failed to start. Run npm run dashboard to inspect errors.",
  );
}
program
  .command("setup")
  .option("--no-credentials", "Do not prompt for credentials")
  .action(async (opts) => {
    checkGitSafety();
    setupProfile();
    chmodSync(paths.profile, 0o600);
    const store = new Store(paths.db);
    store.close();
    console.log(
      "Private template and database ready. Edit private/profile.local.json; configure an authorized resume.",
    );
    if (opts.credentials && process.stdin.isTTY) {
      const password = await promptSecret(
        "Dedicated ATS password (empty to configure later): ",
      );
      if (password) await new Keychain().set("ats-default-password", password);
    }
    console.log("Next: npm run dry-run; npm run build; npm run apply");
  });
program
  .command("credentials")
  .argument("<kind>", "ats or ai")
  .action(async (kind) => {
    if (!["ats", "ai"].includes(kind)) throw new Error("Use ats or ai");
    directories();
    const secret = await promptSecret(
      `${kind === "ats" ? "Dedicated ATS password" : "LLM API key"} (not echoed): `,
    );
    if (!secret) throw new Error("Empty credential");
    await new Keychain().set(
      kind === "ats" ? "ats-default-password" : "llm-api-key",
      secret,
    );
    console.log("Credential stored in macOS Keychain.");
  });
program.command("gmail").action(async () => {
  await new GmailVerification(loadProfile(), new Keychain()).authorize(open);
  console.log("Gmail read-only OAuth configured.");
});
program.command("extract-resume").action(async () => {
  console.log(await extractResume(loadProfile()));
  console.log(
    "Review this extraction before saving an authorized verifiedTextPath file.",
  );
});
program
  .command("dry-run")
  .option("--lookback <days>", "Inclusive age window", "7")
  .action(async (opts) => {
    const lookback = Number(opts.lookback);
    if (!Number.isInteger(lookback) || lookback < 0 || lookback > 30)
      throw new Error("Lookback must be 0–30");
    const { jobs, warnings } = parseFeed(await fetchFeed());
    const store = existsSync(paths.db) ? new Store(paths.db, false) : undefined;
    try {
      const seen = new Set<string>();
      let known = 0;
      const report = jobs
        .filter((j) => eligible(j, lookback))
        .map((j) => {
          if (!j.identity)
            return {
              company: j.company,
              role: j.role,
              age: j.ageDays,
              action: "UNRESOLVED DIRECT LINK",
            };
          const job = store?.findIdentity(j.identity.fingerprint);
          const app = job
            ? store?.list().find((a) => a.job.id === job.id)
            : undefined;
          const duplicate = seen.has(j.identity.fingerprint);
          seen.add(j.identity.fingerprint);
          if (app || duplicate) known++;
          return {
            company: j.company,
            role: j.role,
            age: j.ageDays,
            ats: j.identity.atsType,
            action: app
              ? `KNOWN: ${app.application.status}`
              : duplicate
                ? "DUPLICATE FEED ROW"
                : "WOULD QUEUE",
            url: j.originalApplyUrl,
          };
        });
      console.table(report);
      console.log(
        JSON.stringify(
          {
            eligibleRows: report.length,
            wouldQueue: report.filter((r) => r.action === "WOULD QUEUE").length,
            alreadyKnown: known,
            warnings,
          },
          null,
          2,
        ),
      );
    } finally {
      store?.close();
    }
  });
program
  .command("apply")
  .option("--lookback <days>", "Inclusive window", "7")
  .action(async (opts) => {
    loadProfile(true);
    const lookback = Number(opts.lookback);
    if (!Number.isInteger(lookback) || lookback < 0 || lookback > 30)
      throw new Error("Invalid lookback");
    await ensureRuntime();
    console.log(await api("/api/run", { lookback }));
    console.log(
      `Worker is sequential; review at ${base}. Final Submit is yours.`,
    );
    await open(base).catch(() => console.log(`Open ${base}`));
  });
program.command("dashboard").action(async () => {
  if (!(await running())) await serve();
  await open(base).catch(() => console.log(`Open ${base}`));
});
program.command("serve").action(async () => {
  await serve();
});
program.command("status").action(async () => {
  if (await running()) {
    console.log(await api("/api/status"));
    return;
  }
  if (!existsSync(paths.db)) {
    console.log("Not set up yet. Run npm run setup.");
    return;
  }
  const store = new Store(paths.db, false);
  console.table(
    store.list().map(({ job, application }) => ({
      company: job.company,
      role: job.role,
      status: application.status,
      need: application.attentionReason,
    })),
  );
  store.close();
});
program
  .command("retry")
  .requiredOption("--application <id>")
  .action(async (opts) => {
    await ensureRuntime();
    console.log(await api(`/api/applications/${opts.application}/resume`, {}));
  });
program
  .command("history")
  .requiredOption("--url <url>")
  .requiredOption("--company <company>")
  .requiredOption("--role <role>")
  .action(async (opts) => {
    await ensureRuntime();
    console.log(
      await api("/api/history", {
        url: opts.url,
        company: opts.company,
        role: opts.role,
      }),
    );
  });
try {
  await program.parseAsync();
} catch (e) {
  console.error(e instanceof Error ? e.message : "Command failed");
  process.exitCode = 1;
}
