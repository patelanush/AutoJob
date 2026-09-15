import type { BrowserActions } from "../browser/actions.js";
import type { FactStore } from "../answers/facts.js";
import { normalize } from "../answers/facts.js";
import { mapQuestion, mapValue } from "../answers/resolver.js";
export class ValidationEngine {
  async validate(browser: BrowserActions, facts: FactStore) {
    const evidence = await browser.reviewEvidence(),
      fields = await browser.inspect(),
      incorrect: string[] = [];
    for (const field of fields) {
      const mapping = mapQuestion(field.label.replace(/\s*\*\s*$/, ""));
      if (
        !mapping ||
        mapping.scope !== "global" ||
        !/^contact\.(firstName|lastName|email)$/.test(mapping.key)
      )
        continue;
      const fact = facts.get(mapping.key);
      if (!fact) continue;
      const expected = mapValue(fact.parsed, {
        label: field.label,
        type: field.type,
        choices: field.choices,
        required: field.required,
      });
      if (expected !== null && normalize(expected) !== normalize(field.value))
        incorrect.push(
          `Verify ${field.label}: parsed/current value differs from approved facts.`,
        );
    }
    return { ...evidence, incorrect };
  }
}
