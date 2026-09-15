import { load } from "cheerio";
import { createHash } from "node:crypto";
import { identify } from "./identity.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const FEED =
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md";
export interface FeedJob {
  company: string;
  role: string;
  category: string;
  locationRaw: string;
  originalApplyUrl: string | null;
  simplifyUrl: string | null;
  ageDays: number | null;
  isClosed: boolean;
  observationKey: string;
  identity: ReturnType<typeof identify> | null;
}
export function ageDays(text: string): number | null {
  const m = /^(\d+)\s*(d|mo|y)$/i.exec(text.trim());
  return m ? +m[1] * ({ d: 1, mo: 30, y: 365 }[m[2].toLowerCase()] ?? 1) : null;
}
export function parseFeed(markdown: string): {
  jobs: FeedJob[];
  warnings: string[];
} {
  const jobs: FeedJob[] = [],
    warnings: string[] = [];
  const sections = markdown.split(/^##\s+/m);
  for (const section of sections) {
    const category = section
      .split("\n")[0]
      .replace(/[^\p{L}\p{N}\s,&-]/gu, "")
      .trim();
    const $ = load(section);
    $("table").each((_, table) => {
      const headers = $(table)
        .find("thead th")
        .map((_, h) => $(h).text().trim().toLowerCase())
        .get();
      if (
        !["company", "role", "location", "application", "age"].every((h) =>
          headers.includes(h),
        )
      )
        return;
      let company = "";
      $(table)
        .find("tbody tr")
        .each((rowIndex, row) => {
          const cells = $(row).children("td");
          if (cells.length !== headers.length) {
            warnings.push(`${category}: malformed row ${rowIndex}`);
            return;
          }
          const cell = (name: string) => cells.eq(headers.indexOf(name));
          const companyText = cell("company").text().replace(/🔥/g, "").trim();
          if (companyText !== "↳") company = companyText;
          if (!company) {
            warnings.push(`${category}: orphan continuation`);
            return;
          }
          const role = cell("role").text().trim(),
            app = cell("application");
          const isClosed =
            /🔒|closed/i.test(app.text()) ||
            app
              .find("img")
              .toArray()
              .some((img) => /closed|lock/i.test($(img).attr("alt") ?? ""));
          const urls = app
            .find("a[href]")
            .map((_, a) => $(a).attr("href") ?? "")
            .get();
          const simplifyUrl =
            urls.find((u) => {
              try {
                return /(^|\.)simplify\.jobs$/.test(new URL(u).hostname);
              } catch {
                return false;
              }
            }) ?? null;
          const direct = [
            ...new Set(
              urls.filter((u) => {
                try {
                  return (
                    new URL(u).protocol === "https:" &&
                    !/(^|\.)simplify\.jobs$/.test(new URL(u).hostname)
                  );
                } catch {
                  return false;
                }
              }),
            ),
          ];
          const originalApplyUrl = direct.length === 1 ? direct[0] : null;
          if (!isClosed && !originalApplyUrl)
            warnings.push(
              `${company}: missing or ambiguous direct employer URL`,
            );
          let identity: ReturnType<typeof identify> | null = null;
          if (originalApplyUrl) {
            try {
              identity = identify(originalApplyUrl);
            } catch {
              warnings.push(`${company}: unsafe application URL`);
            }
          }
          const locationRaw =
            cell("location")
              .html()
              ?.replace(/<\/?br\s*\/?\s*>/gi, "\n")
              .replace(/<[^>]*>/g, "")
              .trim() ?? "";
          jobs.push({
            company,
            role,
            category,
            locationRaw,
            originalApplyUrl,
            simplifyUrl,
            ageDays: ageDays(cell("age").text()),
            isClosed,
            observationKey: createHash("sha256")
              .update(
                `${category}|${company}|${role}|${locationRaw}|${originalApplyUrl ?? "no-url"}`,
              )
              .digest("hex"),
            identity,
          });
        });
    });
  }
  if (!jobs.length)
    throw new Error(
      "Feed structure not recognized; refusing to interpret an empty parse as no jobs.",
    );
  return { jobs, warnings };
}
export function eligible(job: FeedJob, lookback = 7) {
  return !job.isClosed && job.ageDays !== null && job.ageDays <= lookback;
}
export async function fetchFeed(cacheDirectory?: string): Promise<string> {
  const cachePath = cacheDirectory
    ? join(cacheDirectory, "feed-cache.json")
    : null;
  let cache: { etag?: string; modified?: string; markdown: string } | null =
    null;
  if (cachePath && existsSync(cachePath)) {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      cache = null;
    }
  }
  let error: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(FEED, {
        signal: AbortSignal.timeout(20000),
        headers: {
          ...(cache?.etag ? { "if-none-match": cache.etag } : {}),
          ...(cache?.modified ? { "if-modified-since": cache.modified } : {}),
        },
      });
      if (r.status === 304 && cache?.markdown) return cache.markdown;
      if (!r.ok) throw new Error(`Feed HTTP ${r.status}`);
      const markdown = await r.text();
      if (cachePath)
        writeFileSync(
          cachePath,
          JSON.stringify({
            etag: r.headers.get("etag"),
            modified: r.headers.get("last-modified"),
            markdown,
          }),
          { mode: 0o600 },
        );
      return markdown;
    } catch (e) {
      error = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error(
    `Feed unavailable: ${error instanceof Error ? error.message : "network error"}`,
  );
}
