import { StructuredAdapter } from "../base/adapter.js";
export class OracleAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "oracle",
      signature: /oraclecloud|CandidateExperience/i,
      stages: [
        "LANDING",
        "AUTH",
        "EMAIL_VERIFY",
        "CONTACT",
        "EXPERIENCE",
        "EDUCATION",
        "QUESTIONS",
        "DISCLOSURES",
        "REVIEW",
      ],
      begin: /^(?:apply|apply now)$/i,
      next: /^(?:next|continue|save and continue)$/i,
      finalRequests: [
        /\/candidateApplications\/[^/]+\/submit/i,
        /\/application\/submit/i,
      ],
    });
  }
}
