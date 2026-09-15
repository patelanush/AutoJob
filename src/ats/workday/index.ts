import { StructuredAdapter } from "../base/adapter.js";
import type { AdapterContext } from "../base/adapter.js";
export async function workdayEntry(c: AdapterContext) {
  const signature = await c.browser.signature();
  if (
    /apply manually/i.test(signature.text) &&
    (await c.browser.hasControl(/^apply manually$/i))
  ) {
    c.browser.stage = "LANDING";
    await c.browser.advance("BEGIN", /^apply manually$/i);
  }
}
export class WorkdayAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "workday",
      signature: /myworkdayjobs|workday/i,
      stages: [
        "LANDING",
        "AUTH",
        "ACCOUNT_CREATE",
        "EMAIL_VERIFY",
        "RESUME",
        "CONTACT",
        "EXPERIENCE",
        "EDUCATION",
        "QUESTIONS",
        "DISCLOSURES",
        "REVIEW",
      ],
      begin: /^(?:apply|apply manually|apply now)$/i,
      next: /^(?:next|save and continue)$/i,
      finalRequests: [
        /\/submitApplication(?:\?|$)/i,
        /\/applications\/[^/]+\/submit/i,
      ],
    });
  }
  protected override async beforeStep(c: AdapterContext) {
    await workdayEntry(c);
  }
}
