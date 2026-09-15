import {
  fieldValueMatches,
  type BrowserActions,
  type Field,
} from "../browser/actions.js";
import { normalize } from "../answers/facts.js";
import {
  AnswerResolver,
  humanOnly,
  mapQuestion,
  type GenerationContext,
  type Question,
} from "../answers/resolver.js";

interface LogicalField {
  question: Question;
  fields: Field[];
}

function logicalFields(fields: Field[]): LogicalField[] {
  const result: LogicalField[] = [],
    grouped = new Map<string, Field[]>();
  for (const field of fields) {
    if (
      field.type === "radio" ||
      (field.type === "checkbox" && field.groupLabel)
    ) {
      const key = field.groupLabel || field.groupName || field.label;
      const values = grouped.get(key) ?? [];
      values.push(field);
      grouped.set(key, values);
    } else {
      result.push({
        question: {
          label: field.label.replace(/\s*\*\s*$/, ""),
          type: field.type,
          choices: field.choices,
          required: field.required,
          maxLength: field.maxLength,
          section: field.section,
        },
        fields: [field],
      });
    }
  }
  for (const [label, fields] of grouped)
    result.push({
      question: {
        label: label.replace(/\s*\*\s*$/, ""),
        type: "radio",
        choices: fields.map(
          (field) => field.optionLabel || field.label.replace(label, "").trim(),
        ),
        required: fields.some((field) => field.required),
      },
      fields,
    });
  return result;
}

function containsAnswer(field: LogicalField, answer: string) {
  if (
    field.fields.length === 1 &&
    !["radio", "checkbox"].includes(field.fields[0].type)
  )
    return fieldValueMatches(field.fields[0], answer);
  const target = field.fields.find(
    (candidate) =>
      normalize(candidate.optionLabel || candidate.label) === normalize(answer),
  );
  return !!target && target.value === "checked";
}

export class ValidationEngine {
  async reconcileKnownRequired(
    browser: BrowserActions,
    resolver: AnswerResolver,
    appId: string,
    context: GenerationContext,
  ) {
    const errors: string[] = [];
    let repaired = 0;
    let current = logicalFields(await browser.inspect());
    const candidates = current.filter(
      ({ question }) =>
        question.required &&
        !!question.label &&
        !humanOnly(question.label) &&
        !!mapQuestion(question.label),
    );
    for (const original of candidates) {
      const candidate = current.find(
        ({ question }) =>
          normalize(question.label) === normalize(original.question.label),
      );
      if (!candidate) continue;
      const resolved = await resolver.resolve(
        candidate.question,
        appId,
        context,
      );
      if (!("answer" in resolved) || containsAnswer(candidate, resolved.answer))
        continue;
      try {
        const target =
          candidate.fields.length === 1 &&
          !["radio", "checkbox"].includes(candidate.fields[0].type)
            ? candidate.fields[0]
            : candidate.fields.find(
                (field) =>
                  normalize(field.optionLabel || field.label) ===
                  normalize(resolved.answer),
              );
        if (!target) throw new Error("Resolved option is unavailable");
        await browser.fill(
          target.token,
          candidate.fields.length === 1 ? resolved.answer : "checked",
        );
        current = logicalFields(await browser.inspect());
        const refreshed = current.find(
          ({ question }) =>
            normalize(question.label) === normalize(candidate.question.label),
        );
        if (!refreshed || !containsAnswer(refreshed, resolved.answer))
          throw new Error("Control did not retain the approved value");
        resolver.record(appId, candidate.question, resolved);
        repaired++;
      } catch {
        errors.push(
          `Automation error: known required value was not accepted for ${candidate.question.label}.`,
        );
      }
    }
    return { errors, repaired };
  }

  async validate(browser: BrowserActions) {
    const evidence = await browser.reviewEvidence();
    return { ...evidence, incorrect: [] as string[] };
  }
}
