import { randomUUID } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import { Store, now } from "../db/store.js";
import {
  facts,
  factHistory,
  aliases,
  applications,
  answerHistory,
} from "../db/schema.js";
import type { Profile } from "../config/profile.js";
export function normalize(q: string) {
  return q
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export function prohibitedFact(key: string) {
  return /password|token|secret|cookie|api.?key|oauth|ssn|social.?security|government.?id|passport.?number|signature|certif(?:y|ication|icationConsent)|consent|attestation/i.test(
    key,
  );
}
export type FactSource =
  "INITIAL_PROFILE" | "HUMAN_CONFIRMED" | "HUMAN_CORRECTED" | "DERIVED";
export class FactStore {
  constructor(readonly store: Store) {}
  get(key: string, scope = "global") {
    const f = this.store.db
      .select()
      .from(facts)
      .where(and(eq(facts.canonicalKey, key), eq(facts.scope, scope)))
      .get();
    return f &&
      !f.unknown &&
      !f.notes?.startsWith("PROFILE_CONFLICT:") &&
      (!f.expiresAt || f.expiresAt > now())
      ? { ...f, parsed: JSON.parse(f.value ?? "null") as unknown }
      : null;
  }
  set(
    key: string,
    value: unknown,
    options: {
      scope?: string;
      source?: FactSource;
      stability?: string;
      expiresAt?: string;
      correct?: boolean;
      revision?: number;
      notes?: string;
    } = {},
  ) {
    if (prohibitedFact(key))
      throw new Error(
        "This sensitive identifier/attestation cannot be persisted",
      );
    if (
      /^identity\.(workAuthorizationUS|sponsorshipRequiredNow|sponsorshipRequiredFuture)$|^preferences\.willingToRelocate$/.test(
        key,
      ) &&
      typeof value !== "boolean"
    )
      throw new Error("This canonical fact requires an explicit boolean value");
    if (
      /^identity\.citizenship$/.test(key) &&
      !(
        typeof value === "string" ||
        (Array.isArray(value) && value.every((v) => typeof v === "string"))
      )
    )
      throw new Error(
        "Citizenship must contain explicitly confirmed country name(s)",
      );
    if (
      /^experience\..*Years$/.test(key) &&
      !(typeof value === "number" && Number.isFinite(value) && value >= 0)
    )
      throw new Error("Experience years require a nonnegative number");
    const scope = options.scope ?? "global",
      source = options.source ?? "HUMAN_CONFIRMED",
      at = now();
    const existing = this.store.db
      .select()
      .from(facts)
      .where(and(eq(facts.canonicalKey, key), eq(facts.scope, scope)))
      .get();
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error("Fact must have a serializable value");
    if (
      existing &&
      options.revision !== undefined &&
      existing.revision !== options.revision
    )
      throw new Error("Fact changed; refresh before correcting");
    if (
      existing &&
      !existing.unknown &&
      existing.value !== encoded &&
      !options.correct
    )
      throw new Error(
        `Fact conflict: ${key}. Confirm a correction before changing the shared fact.`,
      );
    if (existing?.unknown && source === "INITIAL_PROFILE") return existing.id;
    if (
      existing?.value === encoded &&
      !existing.unknown &&
      !options.correct &&
      !source.startsWith("HUMAN")
    )
      return existing.id;
    const id = existing?.id ?? randomUUID(),
      type =
        typeof value === "boolean"
          ? "BOOLEAN"
          : typeof value === "number"
            ? "NUMBER"
            : typeof value === "object"
              ? "JSON"
              : "STRING";
    this.store.db.transaction((tx) => {
      const record = {
        value: encoded,
        valueType: type,
        source,
        stability:
          options.stability ??
          (/contact\.|experience\.|preferences\./.test(key)
            ? "SLOW_CHANGING"
            : "PERMANENT"),
        lastConfirmedAt: at,
        updatedAt: at,
        unknown: false,
        revision: (existing?.revision ?? -1) + 1,
        expiresAt: options.expiresAt ?? null,
        notes: options.notes ?? null,
      };
      if (existing) tx.update(facts).set(record).where(eq(facts.id, id)).run();
      else
        tx.insert(facts)
          .values({
            id,
            canonicalKey: key,
            scope,
            ...record,
            firstConfirmedAt: at,
            createdAt: at,
          })
          .run();
      tx.insert(factHistory)
        .values({
          id: randomUUID(),
          factId: id,
          before: existing?.value ?? null,
          after: encoded,
          source,
          createdAt: at,
        })
        .run();
      if (existing && existing.value !== encoded) {
        const used = tx
          .select()
          .from(answerHistory)
          .where(eq(answerHistory.factKey, key))
          .all();
        for (const a of used) {
          const app = this.store.application(a.applicationId);
          if (app.status === "READY" || app.status === "NEEDS_REVIEW") {
            const match = tx.select().from(facts).where(eq(facts.id, id)).get();
            if (
              match &&
              (scope === "global" ||
                scope === `job:${app.jobId}` ||
                scope ===
                  `company:${normalize(this.store.job(app.jobId).company)}`)
            )
              tx.update(applications)
                .set({
                  status: "NEEDS_REVIEW",
                  attentionReason: `A previously used fact changed: ${key}. Review and Resume.`,
                  updatedAt: at,
                  revision: app.revision + 1,
                })
                .where(eq(applications.id, app.id))
                .run();
          }
        }
      }
    });
    return id;
  }
  unknown(id: string, revision: number) {
    const f = this.store.db.select().from(facts).where(eq(facts.id, id)).get();
    if (!f || f.revision !== revision)
      throw new Error("Fact revision mismatch");
    this.store.db.transaction((tx) => {
      tx.update(facts)
        .set({
          unknown: true,
          value: null,
          revision: f.revision + 1,
          updatedAt: now(),
        })
        .where(eq(facts.id, id))
        .run();
      tx.insert(factHistory)
        .values({
          id: randomUUID(),
          factId: id,
          before: f.value,
          after: null,
          source: "HUMAN_CORRECTED",
          createdAt: now(),
        })
        .run();
    });
    for (const a of this.store.db
      .select()
      .from(answerHistory)
      .where(eq(answerHistory.factKey, f.canonicalKey))
      .all()) {
      const app = this.store.application(a.applicationId);
      if (app.status === "READY")
        this.store.transition(app.id, "NEEDS_REVIEW", {
          attentionReason: `Used fact marked unknown: ${f.canonicalKey}`,
        });
    }
  }
  alias(question: string, key: string, scope = "global", ats?: string) {
    if (prohibitedFact(key)) throw new Error("Prohibited fact");
    if (
      /\bnot\b|\bwithout\b|unauthoriz|other than|\bexcept\b/.test(
        normalize(question),
      )
    )
      throw new Error(
        "Qualified/negative questions require an approved exact answer-bank rule rather than a direct fact alias",
      );
    this.store.db
      .insert(aliases)
      .values({
        id: randomUUID(),
        normalizedQuestion: normalize(question),
        canonicalFactKey: key,
        scope,
        ats,
        confidence: 1,
        source: "HUMAN_CONFIRMED",
        createdAt: now(),
      })
      .onConflictDoUpdate({
        target: [aliases.normalizedQuestion, aliases.scope],
        set: { canonicalFactKey: key },
      })
      .run();
  }
  importProfile(p: Profile) {
    const mapping: Record<string, unknown> = {
      "contact.firstName": p.personal.firstName,
      "contact.middleName": p.personal.middleName,
      "contact.lastName": p.personal.lastName,
      "contact.preferredName": p.personal.preferredName,
      "contact.email": p.personal.email,
      "contact.phone": p.personal.phone,
      "contact.address": p.personal.address,
      "contact.city": p.personal.city,
      "contact.state": p.personal.state,
      "contact.zip": p.personal.zip,
      "contact.country": p.personal.country,
      "links.linkedin": p.links.linkedin,
      "links.github": p.links.github,
      "links.portfolio": p.links.portfolio,
      "identity.citizenship": p.authorization.citizenship,
      "identity.workAuthorizationUS": p.authorization.authorizedToWorkUS,
      "identity.sponsorshipRequiredNow": p.authorization.sponsorshipRequiredNow,
      "identity.sponsorshipRequiredFuture":
        p.authorization.sponsorshipRequiredFuture,
      ...Object.fromEntries(
        Object.entries(p.demographics).map(([k, v]) => [
          `demographics.${k}`,
          v,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(p.preferences).map(([k, v]) => [`preferences.${k}`, v]),
      ),
      "education.records": p.education,
      "employment.records": p.employment,
      ...Object.fromEntries(
        Object.entries(p.education[0] ?? {}).map(([k, v]) => [
          `education.${k}`,
          v,
        ]),
      ),
      ...p.approvedFacts,
    };
    for (const [key, value] of Object.entries(mapping))
      if (value !== undefined) {
        const existing = this.store.db
          .select()
          .from(facts)
          .where(and(eq(facts.canonicalKey, key), eq(facts.scope, "global")))
          .get();
        if (existing?.unknown) continue;
        if (existing && existing.value !== JSON.stringify(value)) {
          const baseline = this.store.db
            .select()
            .from(factHistory)
            .where(
              and(
                eq(factHistory.factId, existing.id),
                sql`${factHistory.source} in ('INITIAL_PROFILE','PROFILE_CONFLICT')`,
              ),
            )
            .orderBy(desc(factHistory.createdAt))
            .get();
          if (baseline?.after === JSON.stringify(value)) continue;
          this.store.db.transaction((tx) => {
            tx.update(facts)
              .set({
                notes:
                  "PROFILE_CONFLICT: private profile changed. Proposed value: " +
                  JSON.stringify(value),
                updatedAt: now(),
              })
              .where(eq(facts.id, existing.id))
              .run();
            tx.insert(factHistory)
              .values({
                id: randomUUID(),
                factId: existing.id,
                before: existing.value,
                after: JSON.stringify(value),
                source: "PROFILE_CONFLICT",
                createdAt: now(),
              })
              .run();
          });
          continue;
        }
        this.set(key, value, { source: "INITIAL_PROFILE" });
      }
  }
}
