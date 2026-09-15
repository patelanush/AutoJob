import { StructuredAdapter } from "../base/adapter.js";
export class ICIMSAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "icims",
      signature: /icims|iCIMS/i,
      stages: [
        "LANDING",
        "AUTH",
        "RESUME",
        "CONTACT",
        "EXPERIENCE",
        "EDUCATION",
        "QUESTIONS",
        "REVIEW",
      ],
      begin: /^(?:apply|apply now|apply for this job)$/i,
      next: /^(?:next|continue|save and continue)$/i,
      finalRequests: [/\/submitApplication/i, /\/application\/submit/i],
    });
  }
}
