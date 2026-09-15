import { normalize } from "./facts.js";
import type { Store } from "../db/store.js";
import type { BrowserActions } from "../browser/actions.js";
import { mapQuestion, humanOnly } from "./resolver.js";
export async function findBrowserCorrections(
  store: Store,
  appId: string,
  browser: BrowserActions,
) {
  const detail = store.details(appId),
    fields = await browser.inspect(),
    latest = new Map<string, (typeof detail.answers)[number]>();
  for (const a of detail.answers) latest.set(a.normalizedQuestion, a);
  const suggestions = [];
  for (const f of fields) {
    if (
      humanOnly(f.label) ||
      ["password", "file", "checkbox", "radio"].includes(f.type) ||
      !f.value
    )
      continue;
    const label = f.label.replace(/\s*\*\s*$/, ""),
      prior = latest.get(normalize(label)),
      pending = detail.questions.find(
        (q) => normalize(q.question) === normalize(label) && !q.resolved,
      );
    if (
      (!prior && !pending) ||
      (prior && normalize(prior.answer) === normalize(f.value))
    )
      continue;
    const mapping = mapQuestion(label);
    suggestions.push({
      question: label,
      previousAnswer: prior?.answer ?? "(previously unknown)",
      newAnswer: f.value,
      canonicalKey:
        prior?.factKey ?? pending?.canonicalKey ?? mapping?.key ?? null,
      scope: mapping?.scope ?? "job",
      requiresConfirmation: true,
    });
  }
  return suggestions;
}
