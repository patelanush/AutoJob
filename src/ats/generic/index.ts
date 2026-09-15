import { StructuredAdapter } from "../base/adapter.js";
export class GenericAdapter extends StructuredAdapter {
  constructor() {
    super({
      type: "generic",
      signature: /.*/,
      stages: ["LANDING", "CONTACT", "QUESTIONS", "REVIEW"],
      begin: /^(?:apply|apply now|apply for this job)$/i,
      next: /^never automatically advance generic multipage forms$/,
      finalRequests: [],
    });
  }
}
