import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import * as s from "./schema.js";
import { root } from "../config/profile.js";
import type { FeedJob } from "../feed/parser.js";
import { planFeedSelection } from "../feed/selection.js";
import type { ATSType } from "../feed/identity.js";
import { redact } from "../security/privacy.js";
export type Status =
  | "DISCOVERED"
  | "QUEUED"
  | "PROCESSING"
  | "READY"
  | "NEEDS_REVIEW"
  | "SKIPPED"
  | "SUBMITTED";
const transitions: Record<Status, Status[]> = {
  DISCOVERED: ["QUEUED", "SUBMITTED"],
  QUEUED: ["PROCESSING", "SKIPPED", "NEEDS_REVIEW", "SUBMITTED"],
  PROCESSING: ["READY", "NEEDS_REVIEW", "SKIPPED", "SUBMITTED"],
  READY: ["NEEDS_REVIEW", "PROCESSING", "SUBMITTED"],
  NEEDS_REVIEW: ["PROCESSING", "SUBMITTED"],
  SKIPPED: ["QUEUED", "PROCESSING", "SUBMITTED"],
  SUBMITTED: [],
};
export function canTransition(from: Status, to: Status) {
  return from === to || transitions[from].includes(to);
}
export const now = () => new Date().toISOString();
export class Store {
  readonly sqlite: Database.Database;
  readonly db;
  constructor(path: string, migrate = true) {
    this.sqlite = new Database(path, {
      readonly: !migrate && path !== ":memory:",
    });
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    if (migrate) {
      this.sqlite.pragma("journal_mode = WAL");
      this.sqlite.exec(
        "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const done = this.sqlite
        .prepare("SELECT version FROM migrations WHERE version = 1")
        .get();
      if (!done)
        this.sqlite.transaction(() => {
          this.sqlite.exec(
            readFileSync(join(root, "src/db/migrations/0001.sql"), "utf8"),
          );
          this.sqlite
            .prepare("INSERT INTO migrations VALUES (1, ?)")
            .run(now());
        })();
      if (path !== ":memory:") chmodSync(path, 0o600);
    }
    this.db = drizzle(this.sqlite, { schema: s });
  }
  close() {
    this.sqlite.close();
  }
  application(id: string) {
    const a = this.db
      .select()
      .from(s.applications)
      .where(eq(s.applications.id, id))
      .get();
    if (!a) throw new Error("Application not found");
    return a;
  }
  job(id: string) {
    const j = this.db.select().from(s.jobs).where(eq(s.jobs.id, id)).get();
    if (!j) throw new Error("Job not found");
    return j;
  }
  findIdentity(fingerprint: string) {
    return (
      this.db
        .select()
        .from(s.jobs)
        .where(eq(s.jobs.fingerprint, fingerprint))
        .get() ??
      (() => {
        const alias = this.db
          .select()
          .from(s.identityAliases)
          .where(eq(s.identityAliases.fingerprint, fingerprint))
          .get();
        return alias ? this.job(alias.jobId) : undefined;
      })()
    );
  }
  hasApplication(jobId: string) {
    return !!this.db
      .select({ id: s.applications.id })
      .from(s.applications)
      .where(eq(s.applications.jobId, jobId))
      .get();
  }
  ingest(
    feed: FeedJob[],
    lookback: number,
    options: { limit?: number; ats?: ATSType } = {},
  ) {
    const plan = planFeedSelection(
      feed,
      lookback,
      (fingerprint) => {
        const job = this.findIdentity(fingerprint);
        return !!job && this.hasApplication(job.id);
      },
      options.limit,
      options.ats,
    );
    const selected = new Set(
      plan.selected.map((job) => job.identity!.fingerprint),
    );
    const applicationIds: string[] = [];
    this.db.transaction((tx) => {
      for (const j of feed) {
        const at = now();
        tx.insert(s.observations)
          .values({
            observationKey: j.observationKey,
            company: j.company,
            role: j.role,
            category: j.category,
            isClosed: j.isClosed,
            lastSeenAt: at,
          })
          .onConflictDoUpdate({
            target: s.observations.observationKey,
            set: { isClosed: j.isClosed, lastSeenAt: at },
          })
          .run();
        if (!j.identity || !j.originalApplyUrl) continue;
        let job = this.findIdentity(j.identity.fingerprint);
        if (!job) {
          const id = randomUUID();
          tx.insert(s.jobs)
            .values({
              id,
              fingerprint: j.identity.fingerprint,
              source: "SimplifyJobs/New-Grad-Positions",
              sourceCategory: j.category,
              company: j.company,
              role: j.role,
              locationRaw: j.locationRaw,
              originalApplyUrl: j.originalApplyUrl,
              canonicalApplyUrl: j.identity.canonicalUrl,
              simplifyUrl: j.simplifyUrl,
              atsType: j.identity.atsType,
              atsJobId: j.identity.atsJobId,
              tenant: j.identity.tenant,
              sourceAgeDays: j.ageDays,
              isClosed: j.isClosed,
              firstSeenAt: at,
              lastSeenAt: at,
              createdAt: at,
              updatedAt: at,
              approximatePostedAt:
                j.ageDays === null
                  ? null
                  : new Date(Date.now() - j.ageDays * 86400000).toISOString(),
            })
            .run();
          job = this.job(id);
        } else
          tx.update(s.jobs)
            .set({
              lastSeenAt: at,
              updatedAt: at,
              sourceAgeDays: j.ageDays,
              isClosed: j.isClosed,
            })
            .where(eq(s.jobs.id, job.id))
            .run();
      }
      for (const fingerprint of selected) {
        const job = this.findIdentity(fingerprint);
        if (!job || this.hasApplication(job.id)) continue;
        const id = randomUUID(),
          at = now();
        tx.insert(s.applications)
          .values({
            id,
            jobId: job.id,
            status: "QUEUED",
            stage: "DISCOVERED",
            createdAt: at,
            updatedAt: at,
            lastUrl: job.canonicalApplyUrl,
          })
          .run();
        applicationIds.push(id);
      }
    });
    return {
      queued: applicationIds.length,
      newJobs: plan.newJobs.length,
      matchingAts: plan.matchingAts.length,
      excludedByAts: plan.excludedByAts,
      alreadyKnown: plan.alreadyKnown,
      deferred: plan.deferred,
      applicationIds,
    };
  }
  transition(
    id: string,
    status: Status,
    changes: Partial<typeof s.applications.$inferInsert> = {},
  ) {
    const a = this.application(id);
    if (!canTransition(a.status as Status, status))
      throw new Error(`Invalid application transition ${a.status} → ${status}`);
    this.db
      .update(s.applications)
      .set({
        ...changes,
        status,
        revision: a.revision + 1,
        updatedAt: now(),
        ...(status === "SUBMITTED"
          ? { submittedAt: now(), sessionAvailable: false }
          : {}),
        ...(status === "READY" ? { preparedAt: now() } : {}),
      })
      .where(eq(s.applications.id, id))
      .run();
  }
  update(id: string, changes: Partial<typeof s.applications.$inferInsert>) {
    const a = this.application(id);
    this.db
      .update(s.applications)
      .set({ ...changes, revision: a.revision + 1, updatedAt: now() })
      .where(eq(s.applications.id, id))
      .run();
  }
  event(
    id: string,
    eventType: string,
    message: string,
    metadata: object = {},
    runId?: string,
  ) {
    this.db
      .insert(s.events)
      .values({
        id: randomUUID(),
        applicationId: id,
        runId,
        timestamp: now(),
        stage: this.application(id).stage,
        eventType,
        message,
        metadata: JSON.stringify(redact(metadata)),
      })
      .run();
  }
  list() {
    return this.db
      .select({
        application: s.applications,
        job: s.jobs,
        aiCount: sql<number>`(select count(*) from answer_history where application_id = ${s.applications.id} and generated = 1)`,
      })
      .from(s.applications)
      .innerJoin(s.jobs, eq(s.applications.jobId, s.jobs.id))
      .orderBy(desc(s.applications.updatedAt))
      .all();
  }
  queue() {
    return this.db
      .select()
      .from(s.applications)
      .where(eq(s.applications.status, "QUEUED"))
      .all();
  }
  recovery() {
    for (const a of this.db
      .select()
      .from(s.applications)
      .where(
        sql`${s.applications.status} in ('PROCESSING','READY','NEEDS_REVIEW')`,
      )
      .all()) {
      if (a.status === "PROCESSING" || a.status === "READY")
        this.transition(a.id, "NEEDS_REVIEW", {
          sessionAvailable: false,
          attentionReason:
            "Browser/session must be recovered and verified. Use Open, then Resume.",
          retryable: true,
        });
      else this.update(a.id, { sessionAvailable: false });
      this.event(
        a.id,
        "RECOVERY",
        "Runtime restarted; previous preparation retained in history.",
      );
    }
    this.db
      .update(s.attempts)
      .set({ finishedAt: now(), outcome: "INTERRUPTED" })
      .where(sql`${s.attempts.finishedAt} is null`)
      .run();
    this.db
      .update(s.runs)
      .set({ finishedAt: now() })
      .where(sql`${s.runs.finishedAt} is null`)
      .run();
  }
  startAttempt(id: string, runId?: string) {
    const a = this.application(id);
    if (a.status === "SUBMITTED")
      throw new Error("Submitted application is terminal");
    if (a.attemptCount >= 3)
      throw new Error("Preparation attempt limit reached");
    const at = now(),
      attemptId = randomUUID();
    this.transition(id, "PROCESSING", {
      attemptCount: a.attemptCount + 1,
      lastAttemptAt: at,
      startedAt: a.startedAt ?? at,
      attentionReason: null,
    });
    this.db
      .insert(s.attempts)
      .values({
        id: attemptId,
        applicationId: id,
        runId,
        startedAt: at,
        lastHeartbeatAt: at,
      })
      .run();
    return attemptId;
  }
  finishAttempt(attemptId: string, outcome: string) {
    this.db
      .update(s.attempts)
      .set({ finishedAt: now(), outcome, lastHeartbeatAt: now() })
      .where(eq(s.attempts.id, attemptId))
      .run();
  }
  details(id: string) {
    const application = this.application(id);
    return {
      application,
      job: this.job(application.jobId),
      events: this.db
        .select()
        .from(s.events)
        .where(eq(s.events.applicationId, id))
        .all(),
      answers: this.db
        .select()
        .from(s.answerHistory)
        .where(eq(s.answerHistory.applicationId, id))
        .all(),
      questions: this.db
        .select()
        .from(s.unresolved)
        .where(eq(s.unresolved.applicationId, id))
        .all(),
      attempts: this.db
        .select()
        .from(s.attempts)
        .where(eq(s.attempts.applicationId, id))
        .all(),
    };
  }
  rememberQuestion(
    id: string,
    question: string,
    choices: string[],
    reason: string,
    canonicalKey?: string,
    scope = "global",
  ) {
    const existing = this.db
      .select()
      .from(s.unresolved)
      .where(
        and(
          eq(s.unresolved.applicationId, id),
          eq(s.unresolved.question, question),
        ),
      )
      .get();
    if (!existing)
      this.db
        .insert(s.unresolved)
        .values({
          id: randomUUID(),
          applicationId: id,
          question,
          choices: JSON.stringify(choices),
          reason,
          canonicalKey,
          scope,
          createdAt: now(),
        })
        .run();
  }
}
