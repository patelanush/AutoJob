import { createHash } from "node:crypto";
import { safeUrl } from "../security/privacy.js";
export type ATSType =
  "greenhouse" | "workday" | "ashby" | "icims" | "oracle" | "generic";
export function canonicalize(raw: string) {
  const u = new URL(safeUrl(raw));
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(ref|tracking|trk|fbclid|gclid|referrer)$/i.test(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  if (!/^#\/|(?:job|requisition|posting)[/=:-]|^#\d+$/i.test(u.hash))
    u.hash = "";
  return u.href;
}
export function identify(raw: string): {
  fingerprint: string;
  canonicalUrl: string;
  atsType: ATSType;
  atsJobId: string | null;
  tenant: string;
} {
  const canonicalUrl = canonicalize(raw),
    u = new URL(canonicalUrl),
    h = u.hostname.toLowerCase(),
    p = u.pathname;
  let atsType: ATSType = "generic",
    atsJobId: string | null = null,
    tenant = h;
  if (/greenhouse/.test(h) || u.searchParams.has("gh_jid")) {
    atsType = "greenhouse";
    atsJobId =
      u.searchParams.get("gh_jid") ??
      (/^\/embed\/job_app/.test(p) ? u.searchParams.get("token") : null) ??
      p.match(/\/jobs\/(\d+)/)?.[1] ??
      p.match(/\/(\d+)\/?$/)?.[1] ??
      null;
    tenant = /greenhouse/.test(h)
      ? (u.searchParams.get("for") ?? p.split("/").filter(Boolean)[0] ?? h)
      : h;
  } else if (/myworkdayjobs\.com$/.test(h)) {
    atsType = "workday";
    atsJobId = p.match(/_([^/]+?)(?:\/apply)?\/?$/)?.[1] ?? null;
    tenant = `${h.split(".")[0]}:${
      p
        .split("/")
        .filter(Boolean)
        .find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s)) ?? ""
    }`;
  } else if (
    /ashbyhq/.test(h) ||
    (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p) &&
      /ashby/i.test(h))
  ) {
    atsType = "ashby";
    atsJobId =
      p.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0].toLowerCase() ?? null;
    tenant = p.split("/").filter(Boolean)[0] ?? h;
  } else if (/icims/.test(h) || u.searchParams.has("icims")) {
    atsType = "icims";
    atsJobId = p.match(/\/jobs\/(\d+)/)?.[1] ?? null;
  } else if (/oraclecloud/.test(h) || /CandidateExperience/i.test(p)) {
    atsType = "oracle";
    atsJobId = p.match(/\/job\/(\w+)/)?.[1] ?? null;
    tenant = `${h}:${p.match(/\/sites\/([^/]+)/)?.[1] ?? ""}`;
  }
  const identity = atsJobId ? `${atsType}:${tenant}:${atsJobId}` : canonicalUrl;
  return {
    fingerprint: createHash("sha256").update(identity).digest("hex"),
    canonicalUrl,
    atsType,
    atsJobId,
    tenant,
  };
}
