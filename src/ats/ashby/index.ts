import { StructuredAdapter } from "../base/adapter.js";
export class AshbyAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "ashby",
      signature: /ashbyhq|ashby-application|ashby/i,
      stages: ["LANDING", "CONTACT", "QUESTIONS", "REVIEW"],
      begin: /^(?:apply|apply for this job|apply now)$/i,
      next: /^(?:next|continue)$/i,
      finalRequests: [/application\.submit/i, /\/application\/submit/i],
    });
  }
}
