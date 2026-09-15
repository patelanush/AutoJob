import { resolve } from "node:path";
import { basename } from "node:path";
import { BrowserActions, SafetyStop, type Field } from "../browser/actions.js";
import {
  AnswerResolver,
  humanOnly,
  type GenerationContext,
} from "../answers/resolver.js";
import type { Profile } from "../config/profile.js";
import { root } from "../config/profile.js";
import { normalize } from "../answers/facts.js";
export interface Preparation {
  missing: string[];
  resumeUploaded: boolean;
  filled: number;
}
export async function prepareFields(
  browser: BrowserActions,
  resolver: AnswerResolver,
  profile: Profile,
  appId: string,
  context: GenerationContext,
): Promise<Preparation> {
  const missing: string[] = [];
  let fields = await browser.inspect(),
    resumeUploaded = false,
    filled = 0;
  for (const f of fields.filter((f) => f.type === "file")) {
    if (/cover.?letter/i.test(f.label)) {
      if (f.required)
        missing.push("Required cover-letter file: provide manually");
      continue;
    }
    if (!/resume|cv|curriculum/i.test(f.label)) {
      if (f.required) missing.push(`Unsupported upload: ${f.label}`);
      continue;
    }
    const path = resolve(root, profile.resume.path),
      uploaded = await browser.upload(f.token, path);
    if (uploaded === basename(path)) {
      resumeUploaded = true;
      filled++;
      resolver.factStore.store.event(
        appId,
        "RESUME_UPLOAD",
        "Authorized resume selected and upload state verified.",
      );
    } else missing.push("Resume upload could not be verified");
  }
  fields = await browser.inspect();
  // Radio choices are resolved as a group, preserving the question separately from each option label.
  const radioGroups = new Map<string, Field[]>();
  for (const f of fields)
    if (f.type === "radio") {
      const key = f.groupLabel || f.groupName || f.label;
      const group = radioGroups.get(key) ?? [];
      group.push(f);
      radioGroups.set(key, group);
    }
  for (const [label, group] of radioGroups) {
    const q = {
      label,
      type: "radio",
      choices: group.map(
        (f) => f.optionLabel || f.label.replace(label, "").trim(),
      ),
      required: group.some((f) => f.required),
    };
    const result = await resolver.resolve(q, appId, context);
    if ("answer" in result) {
      const target = group.find(
        (f) =>
          (f.optionLabel || f.label.replace(label, "").trim()) ===
          result.answer,
      );
      if (target) {
        await browser.fill(target.token, "Yes");
        resolver.record(appId, q, result);
        filled++;
      }
    } else if (q.required) {
      missing.push(`${label}: ${result.reason}`);
      resolver.factStore.store.rememberQuestion(
        appId,
        label,
        q.choices,
        result.reason,
        result.key,
        result.scope,
      );
    }
  }
  for (const f of fields) {
    if (f.type === "radio") continue;
    if (f.type === "file") continue;
    if (!f.label) {
      if (f.required) missing.push("Unlabeled required field");
      continue;
    }
    if (
      /marketing|newsletter|promotional|sms.*(?:update|marketing)|talent network/i.test(
        f.label,
      )
    ) {
      if (f.type === "checkbox" && f.value) await browser.fill(f.token, "No");
      continue;
    }
    if (humanOnly(f.label)) {
      if (f.required && !f.value) missing.push(`Human action: ${f.label}`);
      continue;
    }
    if (/education|experience|employment/i.test(f.section)) {
      const education = /education/i.test(f.section),
        records = resolver.factStore.get(
          education ? "education.records" : "employment.records",
        )?.parsed as Record<string, unknown>[] | undefined,
        record = records?.[f.groupIndex];
      const key = normalize(f.label);
      const property: Record<string, string> = education
        ? {
            school: "school",
            university: "school",
            "school name": "school",
            degree: "degree",
            major: "major",
            minor: "minor",
            gpa: "gpa",
            "graduation date": "graduationDate",
            "start date": "startDate",
          }
        : {
            employer: "employer",
            company: "employer",
            "company name": "employer",
            "job title": "title",
            title: "title",
            location: "location",
            "start date": "startDate",
            "end date": "endDate",
            description: "description",
            responsibilities: "description",
          };
      if (property[key] && record) {
        const canonical = education
          ? `education.${f.groupIndex === 0 ? "" : f.groupIndex + "."}${property[key]}`
          : `employment.${f.groupIndex}.${property[key]}`;
        const approved = resolver.factStore.get(canonical);
        const invalidated = resolver.factStore.store.sqlite
          .prepare(
            "SELECT unknown FROM facts WHERE canonical_key = ? AND scope = ?",
          )
          .get(canonical, "global") as { unknown: number } | undefined;
        const value = invalidated?.unknown
          ? undefined
          : (approved?.parsed ??
            (record as Record<string, unknown>)[property[key]]);
        if (value !== undefined) {
          const choices = f.choices;
          const text = String(value);
          if (choices.length && !choices.includes(text)) {
            if (f.required) missing.push(`Unmapped ${f.label}`);
            continue;
          }
          await browser.fill(f.token, text);
          filled++;
          continue;
        }
      }
    }
    const q = {
      label: f.label.replace(/\s*\*\s*$/, ""),
      type: f.type,
      choices: f.choices,
      required: f.required,
      maxLength: f.maxLength,
      section: f.section,
    };
    const result = await resolver.resolve(q, appId, context);
    if ("answer" in result) {
      try {
        await browser.fill(f.token, result.answer);
        resolver.record(appId, q, result);
        filled++;
      } catch (e) {
        if (e instanceof SafetyStop && e.reason === "TAKEOVER") throw e;
        missing.push(`${f.label}: unsupported field widget`);
      }
    } else if (f.required) {
      missing.push(`${f.label}: ${result.reason}`);
      resolver.factStore.store.rememberQuestion(
        appId,
        q.label,
        q.choices,
        result.reason,
        result.key,
        result.scope,
      );
    }
  }
  return { missing, resumeUploaded, filled };
}
