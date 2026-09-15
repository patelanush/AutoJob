import { execFile, spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/profile.js";
export interface CredentialStore {
  get(account: string): Promise<string>;
  set(account: string, secret: string): Promise<void>;
}
export class Keychain implements CredentialStore {
  private async helper() {
    if (process.platform !== "darwin")
      throw new Error("Keychain requires macOS");
    const bin = join(paths.data, "keychain-helper");
    if (!existsSync(bin)) {
      mkdirSync(paths.data, { recursive: true, mode: 0o700 });
      await new Promise<void>((ok, no) =>
        execFile(
          "/usr/bin/swiftc",
          [
            "-module-cache-path",
            join(paths.data, "swift-cache"),
            join(paths.root, "src/security/keychain.swift"),
            "-o",
            bin,
          ],
          { timeout: 60000 },
          (e) =>
            e
              ? no(
                  new Error(
                    "Could not compile Keychain helper. Install Xcode command-line tools.",
                  ),
                )
              : ok(),
        ),
      );
    }
    return bin;
  }
  private async run(action: string, account: string, input?: string) {
    const bin = await this.helper();
    return new Promise<string>((ok, no) => {
      const c = spawn(bin, [action, "job-apply-agent", account], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let value = "";
      c.stdout.on("data", (b) => (value += b.toString()));
      c.on("error", () => no(new Error("Keychain access failed")));
      c.on("close", (code) =>
        code === 0
          ? ok(value)
          : no(new Error("Keychain credential unavailable or access denied")),
      );
      c.stdin.end(input ?? "");
    });
  }
  get(account: string) {
    return this.run("get", account);
  }
  async set(account: string, secret: string) {
    await this.run("set", account, secret);
  }
}
export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("Run credential setup in an interactive terminal.");
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((ok, no) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", read);
      process.stdout.write("\n");
    };
    const read = (b: Buffer) => {
      for (const char of b.toString()) {
        if (char === "\r" || char === "\n") {
          cleanup();
          ok(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          no(new Error("Credential setup cancelled"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", read);
  });
}
