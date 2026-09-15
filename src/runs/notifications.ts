import { execFile } from "node:child_process";
export function notify(
  summary: { READY: number; NEEDS_REVIEW: number; SKIPPED: number },
  paused: boolean,
) {
  if (process.platform !== "darwin") return;
  const text = `${summary.READY} ready; ${summary.NEEDS_REVIEW} need review; ${summary.SKIPPED} skipped${paused ? "; queue paused" : ""}`;
  execFile(
    "/usr/bin/osascript",
    [
      "-e",
      `display notification "${text}" with title "Application preparation ${paused ? "paused" : "complete"}"`,
    ],
    { timeout: 5000 },
    () => undefined,
  );
}
