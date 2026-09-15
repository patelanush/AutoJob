import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { aliases, answerHistory, facts, unresolved } from "../db/schema.js";
import { FactStore, normalize, prohibitedFact } from "./facts.js";
import { now } from "../db/store.js";
import type { Profile } from "../config/profile.js";
export interface Question {
  label: string;
  type: string;
  choices: string[];
  required: boolean;
  maxLength?: number;
  section?: string;
}
export interface Mapping {
  key: string;
  scope: "global" | "company" | "job";
  transform?: "usCitizen" | "sponsorshipCombined";
}
export function mapQuestion(label: string): Mapping | null {
  const q = normalize(label);
  if (
    /\bnot\b|\bwithout\b|\bunauthoriz|\bnon us\b|\bnon u s\b|other than|\bexcept\b|\bneither\b/.test(
      q,
    )
  )
    return null;
  if (
    /social security|ssn|passport|government id|electronic signature|i certify|i agree|consent|arbitration|background check authorization/.test(
      q,
    )
  )
    return null;
  if (
    /citizen|citizenship/.test(q) &&
    !/export|security|clearance|eligible|national|permanent resident/.test(q)
  )
    return {
      key: "identity.citizenship",
      scope: "global",
      ...(/(?:u s|us|united states|american) citizen|citizen of (?:the )?(?:u s|us|united states)/.test(
        q,
      )
        ? { transform: "usCitizen" as const }
        : {}),
    };
  if (/sponsor/.test(q)) {
    if (/now.*future|currently.*future|now or/.test(q))
      return {
        key: "identity.sponsorshipRequiredNow",
        scope: "global",
        transform: "sponsorshipCombined",
      };
    if (/future/.test(q))
      return { key: "identity.sponsorshipRequiredFuture", scope: "global" };
    if (/now|currently|current/.test(q))
      return { key: "identity.sponsorshipRequiredNow", scope: "global" };
    if (/^(?:do|will) you (?:need|require) visa sponsorship$/.test(q))
      return { key: "identity.sponsorshipRequiredNow", scope: "global" };
    return null;
  }
  if (
    /authoriz|legally.*work|eligible.*work/.test(q) &&
    /united states|u s| usa| us$|america/.test(q) &&
    !/without|not |export/.test(q)
  )
    return { key: "identity.workAuthorizationUS", scope: "global" };
  const exact: Record<string, string> = {
    "first name": "contact.firstName",
    "legal first name": "contact.firstName",
    "given name": "contact.firstName",
    "legal full name": "contact.fullName",
    "full legal name": "contact.fullName",
    "full name": "contact.fullName",
    "middle name": "contact.middleName",
    "middle initial": "contact.middleName",
    "last name": "contact.lastName",
    surname: "contact.lastName",
    "family name": "contact.lastName",
    "preferred name": "contact.preferredName",
    "preferred first name": "contact.preferredName",
    email: "contact.email",
    "e mail": "contact.email",
    "email address": "contact.email",
    "e mail address": "contact.email",
    "preferred email": "contact.email",
    "contact email": "contact.email",
    "primary email": "contact.email",
    phone: "contact.phone",
    "phone number": "contact.phone",
    mobile: "contact.phone",
    "mobile phone": "contact.phone",
    "cell phone": "contact.phone",
    telephone: "contact.phone",
    "primary phone": "contact.phone",
    "contact phone": "contact.phone",
    address: "contact.address",
    "address line 1": "contact.address",
    "address 1": "contact.address",
    "street address": "contact.address",
    "street address line 1": "contact.address",
    city: "contact.city",
    "current city": "contact.city",
    state: "contact.state",
    "state province": "contact.state",
    province: "contact.state",
    zip: "contact.zip",
    "zip code": "contact.zip",
    "postal code": "contact.zip",
    "zip postal code": "contact.zip",
    country: "contact.country",
    location: "contact.location",
    "current location": "contact.location",
    "your location": "contact.location",
    gender: "demographics.gender",
    race: "demographics.race",
    ethnicity: "demographics.ethnicity",
    "veteran status": "demographics.veteranStatus",
    "disability status": "demographics.disabilityStatus",
    linkedin: "links.linkedin",
    "linkedin url": "links.linkedin",
    "linkedin profile": "links.linkedin",
    "linkedin profile url": "links.linkedin",
    github: "links.github",
    "github url": "links.github",
    "github profile": "links.github",
    "github profile url": "links.github",
    portfolio: "links.portfolio",
    "portfolio url": "links.portfolio",
    "personal website": "links.portfolio",
    website: "links.portfolio",
    "desired salary": "preferences.salaryExpectation",
    "salary expectation": "preferences.salaryExpectation",
    "salary expectations": "preferences.salaryExpectation",
    "country of citizenship": "identity.citizenship",
    school: "education.school",
    university: "education.school",
    "school name": "education.school",
    "college university": "education.school",
    degree: "education.degree",
    "degree type": "education.degree",
    major: "education.major",
    "field of study": "education.major",
    "graduation date": "education.graduationDate",
    "graduation year": "education.graduationDate",
    "expected graduation year": "education.graduationDate",
    gpa: "education.gpa",
    "grade point average": "education.gpa",
    "which degree are you currently pursuing": "education.degree",
    "when is your expected graduation date": "education.graduationDate",
    source: "preferences.jobSource",
    "job source": "preferences.jobSource",
    "referral source": "preferences.jobSource",
  };
  if (exact[q]) return { key: exact[q], scope: "global" };
  if (
    /^(?:what is your |please select your |select your )?(?:gender|race|ethnicity)(?: identity)?$/.test(
      q,
    )
  )
    return {
      key: `demographics.${q.match(/gender|race|ethnicity/)?.[0]}`,
      scope: "global",
    };
  if (/veteran|active member.*armed forces/.test(q))
    return { key: "demographics.veteranStatus", scope: "global" };
  if (/disability|chronic condition/.test(q))
    return { key: "demographics.disabilityStatus", scope: "global" };
  if (/transgender/.test(q))
    return { key: "demographics.transgender", scope: "global" };
  if (/sexual orientation|sexual identity/.test(q))
    return { key: "demographics.sexualOrientation", scope: "global" };
  if (/gender identity/.test(q))
    return { key: "demographics.gender", scope: "global" };
  if (/racial ethnic background|race ethnicity|racial background/.test(q))
    return { key: "demographics.race", scope: "global" };
  if (
    /recently graduated|currently attending.*college|university.*us.*canada/.test(
      q,
    )
  )
    return {
      key: "education.attendingOrRecentlyGraduatedUSCanada",
      scope: "global",
    };
  if (/degree in computer science|computer science or a related field/.test(q))
    return { key: "education.csOrRelatedDegree", scope: "global" };
  if (/which degree|degree.*currently pursuing/.test(q))
    return { key: "education.degree", scope: "global" };
  if (/expected graduation date/.test(q))
    return { key: "education.graduationDate", scope: "global" };
  if (/within 50 miles.*(?:hub|san francisco|seattle)/.test(q))
    return { key: "preferences.withinHub50Miles", scope: "job" };
  if (/previously.*(?:work|employ)|ever.*(?:work|employ)/.test(q))
    return { key: "employment.previouslyEmployed", scope: "company" };
  if (/relatives|family member/.test(q) && /employ|work/.test(q))
    return { key: "employment.relativesEmployed", scope: "company" };
  if (/years/.test(q) && /experience/.test(q)) {
    const skill = q.match(/\b(java|python|javascript|aws|react)\b/)?.[1];
    if (skill && !/professional|commercial|paid/.test(q))
      return { key: `experience.${skill}Years`, scope: "global" };
    return null;
  }
  if (
    /willing to relocate|would you relocate for (?:this|the) (?:position|job|role)|open to relocation/.test(
      q,
    )
  )
    return { key: "preferences.willingToRelocate", scope: "global" };
  if (/relocat/.test(q))
    return {
      key: "preferences.willingToRelocate",
      scope: /\b(?:city|location|office|site|area|state)\b/.test(q)
        ? "job"
        : "global",
    };
  if (
    /how did you (?:hear|learn)|how did you find|where did you find|learn about (?:this|the) (?:job|role|position|opportunity)/.test(
      q,
    )
  )
    return { key: "preferences.jobSource", scope: "global" };
  return null;
}
export function humanOnly(q: string) {
  return /password|one.time.*code|otp|ssn|social security|government id|passport number|signature|certify|attest|consent|i agree|arbitration|background.check.authorization/i.test(
    q,
  );
}
export function openEnded(q: string) {
  return (
    /why (?:do you|are you|this|our)|tell us about yourself|describe (?:your|a relevant)|relevant experience|cover letter|interest.*(?:position|role|company|team)/i.test(
      q,
    ) &&
    !/years|citizen|visa|convict|clearance|license|disability|veteran|salary|ethnicity|export|certify|attest|signature/i.test(
      q,
    )
  );
}
function configuredRaceChoice(value: unknown, question: Question) {
  if (!/race|racial|ethnic background/i.test(question.label)) return null;
  const configured = (Array.isArray(value) ? value : [value]).map((entry) =>
      normalize(String(entry)),
    ),
    has = (race: string) => configured.includes(race),
    option = (race: string, generic = false) =>
      question.choices.find((choice) => {
        const candidate = normalize(choice);
        if (generic)
          return (
            candidate === "asian" ||
            /^asian not (?:hispanic|latino)/.test(candidate)
          );
        const [qualifier] = race.split(" ");
        return (
          new RegExp(`\\b${race.replace(" ", "\\s+")}\\b`).test(candidate) ||
          new RegExp(`\\basian\\s+${qualifier}\\b`).test(candidate)
        );
      });
  for (const race of ["south asian", "east asian", "southeast asian"])
    if (has(race)) {
      const specific = option(race);
      if (specific) return specific;
    }
  if (
    has("asian") ||
    has("south asian") ||
    has("east asian") ||
    has("southeast asian")
  )
    return option("asian", true);
  return null;
}
export function mapValue(value: unknown, question: Question): string | null {
  const race = configuredRaceChoice(value, question);
  if (race) return race;
  const text =
    typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  if (!question.choices.length) return text;
  const norm = normalize(text),
    exact = question.choices.filter((c) => normalize(c) === norm);
  if (exact.length === 1) return exact[0];
  const synonyms: Record<string, string[]> = {
    "united states": ["united states of america", "usa", "us"],
    male: ["man", "male man"],
    asian: ["asian not hispanic or latino"],
    heterosexual: ["straight", "heterosexual straight"],
  };
  const matches = question.choices.filter(
    (c) =>
      synonyms[norm]?.includes(normalize(c)) ||
      (typeof value === "boolean" &&
        normalize(c).startsWith(value ? "yes " : "no ")),
  );
  if (matches.length === 1) return matches[0];
  if (norm === "linkedin") {
    const linkedIn = question.choices
      .map((choice, index) => {
        const candidate = normalize(choice);
        return {
          choice,
          index,
          score:
            candidate === "linkedin"
              ? 3
              : candidate.startsWith("linkedin ")
                ? 2
                : /\blinkedin\b/.test(candidate)
                  ? 1
                  : 0,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    if (linkedIn.length) return linkedIn[0].choice;
    const other = question.choices.filter(
      (choice) => normalize(choice) === "other",
    );
    if (!linkedIn.length && other.length === 1) return other[0];
  }
  if (/degree/i.test(question.label)) {
    const level = norm.match(/bachelor|master|doctor|phd/)?.[0];
    if (level) {
      const degreeMatches = question.choices.filter((choice) => {
        const candidate = normalize(choice);
        return level === "doctor" || level === "phd"
          ? /doctor|phd/.test(candidate)
          : candidate.startsWith(level);
      });
      if (degreeMatches.length === 1) return degreeMatches[0];
    }
  }
  if (/graduation/i.test(question.label)) {
    const year = text.match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (year) {
      const yearMatches = question.choices.filter((choice) =>
        new RegExp(`\\b${year}\\b`).test(choice),
      );
      if (yearMatches.length === 1) return yearMatches[0];
    }
  }
  if (
    (/veteran|armed forces/i.test(question.label) &&
      /^(?:not a veteran|no veteran)/.test(norm)) ||
    (/disability|chronic condition/i.test(question.label) &&
      /^(?:no disability|not disabled)/.test(norm))
  ) {
    const noMatches = question.choices.filter((choice) =>
      normalize(choice).startsWith("no"),
    );
    if (noMatches.length === 1) return noMatches[0];
  }
  return null;
}
export interface GenerationContext {
  company: string;
  role: string;
  description: string;
  facts: Record<string, unknown>;
}
export type Generate = (
  question: Question,
  context: GenerationContext,
) => Promise<string | null>;
export class AnswerResolver {
  constructor(
    readonly factStore: FactStore,
    readonly profile: Profile,
    readonly generate?: Generate,
  ) {}
  async resolve(
    q: Question,
    appId: string,
    context: GenerationContext,
  ): Promise<
    | {
        answer: string;
        source: string;
        key?: string;
        revision?: number;
        scope?: string;
      }
    | { reason: string; key?: string; scope?: string }
  > {
    if (humanOnly(q.label))
      return {
        reason:
          "Human identifier, signature, certification or consent required.",
      };
    const store = this.factStore.store,
      app = store.application(appId),
      job = store.job(app.jobId);
    const human = store.db
      .select()
      .from(unresolved)
      .where(
        and(
          eq(unresolved.applicationId, appId),
          eq(unresolved.question, q.label),
          eq(unresolved.resolved, true),
        ),
      )
      .get();
    if (human?.answer) {
      const answer = mapValue(JSON.parse(human.answer), q);
      if (answer !== null) return { answer, source: "HUMAN" };
    }
    let mapping = mapQuestion(q.label);
    if (!mapping) {
      const possible = store.db
        .select()
        .from(aliases)
        .where(
          and(
            eq(aliases.normalizedQuestion, normalize(q.label)),
            sql`${aliases.confidence} >= 0.99`,
          ),
        )
        .all()
        .filter(
          (a) =>
            (!a.ats || a.ats === job.atsType) &&
            [
              "global",
              `company:${normalize(job.company)}`,
              `job:${job.id}`,
            ].includes(a.scope),
        );
      const keys = new Set(possible.map((a) => a.canonicalFactKey));
      if (keys.size === 1 && possible.length) {
        const a = possible[0];
        mapping = {
          key: a.canonicalFactKey,
          scope: a.scope.startsWith("company:")
            ? "company"
            : a.scope.startsWith("job:")
              ? "job"
              : "global",
        };
      } else if (keys.size > 1)
        return { reason: "Conflicting learned question mappings" };
    }
    if (mapping && !prohibitedFact(mapping.key)) {
      const scope =
        mapping.scope === "company"
          ? `company:${normalize(job.company)}`
          : mapping.scope === "job"
            ? `job:${job.id}`
            : "global";
      const f = this.factStore.get(mapping.key, scope);
      if (f) {
        let value = f.parsed;
        if (mapping.transform === "usCitizen")
          value = (Array.isArray(value) ? value : [value]).some((v) =>
            ["united states", "united states of america", "us", "usa"].includes(
              normalize(String(v)),
            ),
          );
        if (mapping.transform === "sponsorshipCombined") {
          const future = this.factStore.get(
            "identity.sponsorshipRequiredFuture",
          );
          if (!future)
            return {
              reason: "Future sponsorship fact is unknown",
              key: "identity.sponsorshipRequiredFuture",
              scope: "global",
            };
          value = Boolean(value) || Boolean(future.parsed);
        }
        const answer = mapValue(value, q);
        if (answer === null)
          return {
            reason:
              "Configured fact cannot be mapped unambiguously to available choices",
            key: mapping.key,
            scope,
          };
        if (q.maxLength && answer.length > q.maxLength)
          return {
            reason: "Factual answer exceeds field limit",
            key: mapping.key,
            scope,
          };
        return {
          answer,
          source: f.source === "INITIAL_PROFILE" ? "PROFILE" : "HUMAN",
          key: mapping.key,
          revision: f.revision,
          scope,
        };
      }
      if (mapping.key === "contact.preferredName" && q.required) {
        const legalFirstName = this.factStore.get("contact.firstName");
        if (legalFirstName) {
          const answer = mapValue(legalFirstName.parsed, q);
          if (answer !== null)
            return {
              answer,
              source: "DERIVED",
              key: "contact.firstName",
              revision: legalFirstName.revision,
              scope: "global",
            };
        }
      }
      return {
        reason: `Unknown approved fact: ${mapping.key}`,
        key: mapping.key,
        scope,
      };
    }
    const bank = this.profile.answerBank.find(
      (rule) =>
        normalize(rule.question) === normalize(q.label) &&
        [
          "global",
          `company:${normalize(job.company)}`,
          `job:${job.id}`,
        ].includes(rule.scope),
    );
    if (bank) {
      const answer = mapValue(bank.answer, q);
      if (answer !== null) return { answer, source: "ANSWER_BANK" };
    }
    if (openEnded(q.label) && this.generate) {
      const answer = await this.generate(q, context);
      if (answer) return { answer, source: "GENERATED" };
      return { reason: "AI answer unavailable or failed factual validation" };
    }
    return {
      reason: openEnded(q.label)
        ? "Configure an AI provider or answer this question"
        : "No approved answer; do not guess factual/legal information",
    };
  }
  record(
    appId: string,
    q: Question,
    resolved: {
      answer: string;
      source: string;
      key?: string;
      revision?: number;
      scope?: string;
    },
  ) {
    if (humanOnly(q.label)) return;
    const store = this.factStore.store;
    store.db.transaction((tx) => {
      tx.insert(answerHistory)
        .values({
          id: randomUUID(),
          applicationId: appId,
          normalizedQuestion: normalize(q.label),
          originalQuestion: q.label,
          answer: resolved.answer,
          answerSource: resolved.source,
          generated: resolved.source === "GENERATED",
          factKey: resolved.key,
          factRevision: resolved.revision,
          createdAt: now(),
        })
        .run();
      tx.update(unresolved)
        .set({ answer: JSON.stringify(resolved.answer), resolved: true })
        .where(
          and(
            eq(unresolved.applicationId, appId),
            eq(unresolved.question, q.label),
          ),
        )
        .run();
    });
    if (resolved.key) {
      const f = this.factStore.get(resolved.key, resolved.scope);
      if (f)
        store.db
          .update(facts)
          .set({ usedCount: f.usedCount + 1 })
          .where(eq(facts.id, f.id))
          .run();
    }
  }
}
