import { GreenhouseAdapter } from "./greenhouse/index.js";
import { WorkdayAdapter } from "./workday/index.js";
import { AshbyAdapter } from "./ashby/index.js";
import { ICIMSAdapter } from "./icims/index.js";
import { OracleAdapter } from "./oracle/index.js";
import { GenericAdapter } from "./generic/index.js";
import type { ATSAdapter } from "./base/adapter.js";
export const adapters: ATSAdapter[] = [
  new GreenhouseAdapter(),
  new WorkdayAdapter(),
  new AshbyAdapter(),
  new ICIMSAdapter(),
  new OracleAdapter(),
  new GenericAdapter(),
];
export function selectAdapter(
  s: { url: string; html: string; text: string },
  hint?: string,
) {
  return (
    adapters.find((a) => a.type === hint && a.canHandle(s)) ??
    adapters.find((a) => a.canHandle(s))!
  );
}
