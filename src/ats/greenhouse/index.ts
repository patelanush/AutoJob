import { StructuredAdapter } from "../base/adapter.js";
export class GreenhouseAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "greenhouse",
      signature: /greenhouse|gh_jid|grnhse/i,
      stages: ["LANDING", "CONTACT", "QUESTIONS", "DISCLOSURES", "REVIEW"],
      begin: /^(?:apply|apply now|apply for this job)$/i,
      next: /^(?:next|continue)$/i,
      finalRequests: [
        /boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs\/\d+/i,
        /boards\.greenhouse\.io\/embed\/job_app/i,
        /greenhouse.*\/applications(?:\?|$)/i,
        /\/application\/submit(?:\?|$)/i,
      ],
    });
  }
}
