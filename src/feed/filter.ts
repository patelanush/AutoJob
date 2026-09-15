import type { FeedJob } from "./parser.js";
/** Extension point only: no fit/title/category filtering is enabled by default. */
export type JobFilter = (job: FeedJob) => boolean;
export function optionalFilters(job: FeedJob, filters: JobFilter[] = []) {
  return filters.every((filter) => filter(job));
}
