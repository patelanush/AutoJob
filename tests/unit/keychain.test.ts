import { vi, it, expect } from "vitest";
import type { EventEmitter as Emitter } from "node:events";
const captured = vi.hoisted(() => ({ args: [] as string[], input: "" }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    execFile: (
      _bin: string,
      _args: unknown,
      _options: unknown,
      callback: (e: null) => void,
    ) => callback(null),
    spawn: (_bin: string, args: string[]) => {
      captured.args = args;
      const process = new EventEmitter() as Emitter & {
        stdout: Emitter;
        stdin: { end: (input: string) => void };
      };
      process.stdout = new EventEmitter();
      process.stdin = {
        end(input: string) {
          captured.input = input;
          queueMicrotask(() => process.emit("close", 0));
        },
      };
      return process;
    },
  };
});
import { Keychain } from "../../src/security/keychain.js";
it("Keychain writes secret over stdin, never argv", async () => {
  if (process.platform !== "darwin") return;
  await new Keychain().set("test-account", "dummy-test-secret");
  expect(captured.args).toEqual(["set", "job-apply-agent", "test-account"]);
  expect(captured.args.join(" ")).not.toContain("dummy-test-secret");
  expect(captured.input).toBe("dummy-test-secret");
});
