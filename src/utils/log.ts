import pino from "pino";
import { redact } from "../security/privacy.js";
const logger = pino({
  level: "info",
  redact: ["password", "token", "cookie", "secret"],
});
export function log(message: string, metadata: Record<string, unknown> = {}) {
  logger.info(redact(metadata) as object, message);
}
