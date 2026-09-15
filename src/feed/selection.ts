import { eligible, type FeedJob } from "./parser.js";
import type { ATSType } from "./identity.js";

export const ATS_TYPES = [
  "workday",
  "greenhouse",
  "ashby",
  "icims",
  "oracle",
  "generic",
] as const satisfies readonly ATSType[];

export function parseAtsType(value: string | undefined): ATSType | undefined {
  if (value === undefined) return undefined;
  if (!(ATS_TYPES as readonly string[]).includes(value))
    throw new Error(`ATS must be one of: ${ATS_TYPES.join(", ")}`);
  return value as ATSType;
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Limit must be a positive integer");
  return limit;
}

export function planFeedSelection(
  feed: FeedJob[],
  lookback: number,
  isKnown: (fingerprint: string) => boolean,
  limit?: number,
  ats?: ATSType,
) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error("Limit must be a positive integer");
  const eligibleJobs = feed.filter((job) => eligible(job, lookback));
  const seen = new Set<string>();
  const newJobs: FeedJob[] = [];
  let alreadyKnown = 0;
  let duplicateRows = 0;
  for (const job of eligibleJobs) {
    if (!job.identity || !job.originalApplyUrl) continue;
    const fingerprint = job.identity.fingerprint;
    if (seen.has(fingerprint)) {
      duplicateRows++;
      continue;
    }
    seen.add(fingerprint);
    if (isKnown(fingerprint)) alreadyKnown++;
    else newJobs.push(job);
  }
  if (ats !== undefined && !ATS_TYPES.includes(ats))
    throw new Error(`ATS must be one of: ${ATS_TYPES.join(", ")}`);
  const matchingAts = ats
    ? newJobs.filter((job) => job.identity?.atsType === ats)
    : newJobs;
  const selected =
    limit === undefined
      ? matchingAts
      : matchingAts.slice(0, Math.min(limit, matchingAts.length));
  return {
    eligibleRows: eligibleJobs.length,
    newJobs,
    matchingAts,
    selected,
    alreadyKnown,
    duplicateRows,
    unresolvedRows: eligibleJobs.filter(
      (job) => !job.identity || !job.originalApplyUrl,
    ).length,
    excludedByAts: newJobs.length - matchingAts.length,
    deferred: matchingAts.length - selected.length,
  };
}
