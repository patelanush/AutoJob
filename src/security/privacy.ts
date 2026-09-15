import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { root, paths } from "../config/profile.js";
const secretKeys =
  /password|secret|token|cookie|authorization|gmailBody|otp|ssn|government.?id/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKeys.test(k) ? "[REDACTED]" : redact(v),
      ]),
    );
  if (typeof value === "string")
    return value
      .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
      .replace(
        /([?&](?:token|code|key|signature|password|access_token)=)[^&\s]+/gi,
        "$1[REDACTED]",
      );
  return value;
}
export function safeUrl(raw: string, localFixture = false): string {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    (u.protocol !== "https:" &&
      !(
        localFixture &&
        u.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(u.hostname)
      ))
  )
    throw new Error("Unsafe navigation URL");
  if (
    !localFixture &&
    (/^(localhost|.*\.localhost)$/i.test(u.hostname) ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        u.hostname,
      ) ||
      u.hostname.includes(":"))
  )
    throw new Error("Private network application URL rejected");
  return u.href;
}
export function contained(base: string, path: string): string {
  const full = resolve(base, path),
    anchor = realpathSync(base),
    actual = existsSync(full) ? realpathSync(full) : full;
  const rel = relative(anchor, actual);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Path outside authorized directory");
  return actual;
}
export function checkGitSafety() {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top !== root)
      throw new Error("Project must have its own Git repository boundary.");
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0");
    if (
      tracked.some(
        (f) =>
          /^(private|data)\/|\.env(?:$|\.local)|\.local\.json$|\.(sqlite|db|pdf|docx)$/.test(
            f,
          ) && f !== ".env.example",
      )
    )
      throw new Error(
        "Private runtime material is tracked by Git. Remove it from tracking before running.",
      );
    for (const file of [
      "private/profile.local.json",
      "data/agent.sqlite",
      "data/browser/Cookies",
      ".env.local",
    ]) {
      try {
        execFileSync("git", ["check-ignore", "--no-index", file], {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        throw new Error(`Private path is not ignored: ${file}`);
      }
    }
  } catch (e) {
    throw new Error(
      `Git safety check failed: ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }
}
export function artifactPath(name: string) {
  return contained(paths.artifacts, name);
}
