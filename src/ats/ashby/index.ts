import { StructuredAdapter } from "../base/adapter.js";
import type { AdapterContext } from "../base/adapter.js";
import { SafetyStop } from "../../browser/actions.js";
export class AshbyAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "ashby",
      signature: /ashbyhq|ashby-application|ashby/i,
      stages: ["LANDING", "CONTACT", "QUESTIONS", "REVIEW"],
      begin: /^(?:apply|apply for this job|apply now)$/i,
      next: /^(?:next|continue)$/i,
      finalRequests: [
        /application\.submit/i,
        /\/application\/submit/i,
        /submit.*application/i,
      ],
    });
  }
  protected override async beforeStep(c: AdapterContext) {
    if (c.browser.stage !== "LANDING") return;
    const ready = await c.browser.waitForApplicationForm(
      /^(?:legal full name|email|resume|linkedin url)$/i,
      20000,
    );
    if (!ready) {
      await c.diagnose?.(
        "ASHBY_FORM_HYDRATION_TIMEOUT",
        await c.browser.formDiagnostics(),
      );
      throw new SafetyStop(
        "Ashby application form did not finish loading. Resume to retry without creating a duplicate.",
        "FORM_LOADING",
      );
    }
  }
}
