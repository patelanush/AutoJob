import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  paths,
  directories,
  loadProfile,
  type Profile,
} from "../config/profile.js";
import { Store, now } from "../db/store.js";
import {
  runs,
  identityAliases,
  jobs,
  unresolved,
  answerHistory,
  events,
} from "../db/schema.js";
import { FactStore, normalize } from "../answers/facts.js";
import { AnswerResolver, humanOnly, mapQuestion } from "../answers/resolver.js";
import { Sessions } from "../browser/session.js";
import { SafetyStop } from "../browser/actions.js";
import { fetchFeed, parseFeed, eligible } from "../feed/parser.js";
import { identify, type ATSType } from "../feed/identity.js";
import { selectAdapter } from "../ats/index.js";
import { Keychain } from "../security/keychain.js";
import { CompatibleProvider } from "../llm/provider.js";
import { verifiedResumeText } from "../llm/context.js";
import { GmailVerification } from "../verification/gmail.js";
import { artifactPath, redact } from "../security/privacy.js";
import { notify } from "./notifications.js";
import { log } from "../utils/log.js";
export class Runtime {
  readonly store: Store;
  readonly facts: FactStore;
  readonly sessions: Sessions;
  readonly credentials = new Keychain();
  profile: Profile;
  busy = false;
  paused = false;
  lastError: string | null = null;
  feedExceptions: {
    company: string;
    role: string;
    category: string;
    reason: string;
  }[] = [];
  runId?: string;
  private retryQueue: string[] = [];
  private authAttempts = new Set<string>();
  private stopping = false;
  private workerTask?: Promise<void>;
  private activeQueue?: string[];
  private deferredByLimit = 0;
  private launchWorker() {
    if (!this.busy) this.workerTask = this.work();
  }
  constructor() {
    directories();
    this.profile = loadProfile();
    this.store = new Store(paths.db);
    this.store.recovery();
    this.facts = new FactStore(this.store);
    this.facts.importProfile(this.profile);
    if (existsSync(join(paths.data, "feed.latest.md"))) {
      try {
        this.feedExceptions = parseFeed(
          readFileSync(join(paths.data, "feed.latest.md"), "utf8"),
        )
          .jobs.filter((j) => eligible(j, 7) && !j.identity)
          .map((j) => ({
            company: j.company,
            role: j.role,
            category: j.category,
            reason:
              "No safe direct employer link; source observation retained.",
          }));
      } catch {
        this.lastError =
          "Last feed snapshot could not be parsed; run a fresh feed scan.";
      }
    }
    this.sessions = new Sessions(this.store, this.profile);
  }
  async ingest(lookback: number, limit?: number, ats?: ATSType) {
    if (this.busy) throw new Error("Worker already running");
    this.profile = loadProfile(true);
    this.facts.importProfile(this.profile);
    this.sessions.hosts.reset();
    this.authAttempts.clear();
    const raw = await fetchFeed(paths.data);
    writeFileSync(join(paths.data, "feed.latest.md"), raw, { mode: 0o600 });
    const parsed = parseFeed(raw),
      counts = this.store.ingest(parsed.jobs, lookback, { limit, ats });
    this.activeQueue =
      limit === undefined && ats === undefined
        ? undefined
        : [...counts.applicationIds];
    this.deferredByLimit = counts.deferred;
    this.feedExceptions = parsed.jobs
      .filter((j) => eligible(j, lookback) && !j.identity)
      .map((j) => ({
        company: j.company,
        role: j.role,
        category: j.category,
        reason:
          "No unambiguous safe direct employer URL. Retained as a source observation; not queued.",
      }));
    this.runId = randomUUID();
    this.store.db
      .insert(runs)
      .values({
        id: this.runId,
        startedAt: now(),
        lookbackDays: lookback,
        discoveredCount: parsed.jobs.filter((j) => eligible(j, lookback))
          .length,
        queuedCount: counts.queued,
        alreadyKnownCount: counts.alreadyKnown,
        deferredCount: counts.deferred,
        errorCount: parsed.warnings.length,
      })
      .run();
    this.paused = false;
    this.launchWorker();
    return {
      runId: this.runId,
      eligibleJobs: parsed.jobs.filter((job) => eligible(job, lookback)).length,
      newJobs: counts.newJobs,
      matchingAts: counts.matchingAts,
      excludedByAts: counts.excludedByAts,
      queued: counts.queued,
      alreadyKnown: counts.alreadyKnown,
      deferredByLimit: counts.deferred,
      limit: limit ?? null,
      ats: ats ?? null,
    };
  }
  async submitted(id: string) {
    const a = this.store.application(id);
    if (a.status === "SUBMITTED") return;
    this.sessions.takeOver(id);
    this.store.transition(id, "SUBMITTED");
    this.store.event(
      id,
      "SUBMITTED",
      "Submission confirmed by human or strong passive success observation.",
    );
    await this.sessions.close(id);
  }
  async retry(id: string, humanResolved = false, only = false) {
    loadProfile(true);
    const a = this.store.application(id);
    const repairedAdapterFalseNegative =
      a.status === "SKIPPED" &&
      !a.retryable &&
      a.attentionReason ===
        "No supported application fields or verified final review state found.";
    if (a.status === "SUBMITTED")
      throw new Error("Submitted application cannot resume");
    if (a.attemptCount >= 3)
      throw new Error("Preparation attempt limit reached; resolve manually.");
    if (a.status === "PROCESSING" || a.status === "QUEUED")
      throw new Error("Application already queued/processing");
    if (this.retryQueue.includes(id))
      throw new Error("Application resume is already queued");
    if (
      a.status === "SKIPPED" &&
      !a.retryable &&
      !repairedAdapterFalseNegative &&
      (!humanResolved || !this.sessions.has(id))
    )
      throw new Error(
        "Skipped cause needs human resolution before retry; open and resolve it.",
      );
    if (only && this.busy)
      throw new Error("Wait for the active worker before an isolated retry.");
    if (repairedAdapterFalseNegative) {
      this.store.update(id, { retryable: true });
      this.store.event(
        id,
        "RECLASSIFIED_RETRYABLE",
        "Previously unsupported field detection is retryable after the adapter fix.",
      );
    }
    this.sessions.hosts.check(
      new URL(a.lastUrl ?? this.store.job(a.jobId).canonicalApplyUrl).hostname,
    );
    if (humanResolved)
      this.store.event(
        id,
        "HUMAN_RESOLUTION",
        "Human explicitly confirmed the blocking issue was resolved; one bounded resume requested.",
      );
    this.retryQueue.push(id);
    if (only) this.activeQueue = [];
    this.paused = false;
    this.launchWorker();
  }
  continue() {
    loadProfile(true);
    this.paused = false;
    this.launchWorker();
  }
  async work() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    this.lastError = null;
    try {
      while (!this.stopping && !this.paused) {
        while (
          this.activeQueue?.length &&
          this.store.application(this.activeQueue[0]).status !== "QUEUED"
        )
          this.activeQueue.shift();
        const id =
          this.retryQueue[0] ??
          (this.activeQueue ? this.activeQueue[0] : this.store.queue()[0]?.id);
        if (!id) break;
        await this.sessions.start();
        if (
          !this.sessions.has(id) &&
          this.sessions.retained() >= this.profile.browser.reviewTabLimit
        ) {
          this.paused = true;
          log("Review capacity reached: worker paused", { limit: 10 });
          break;
        }
        if (this.retryQueue[0] === id) this.retryQueue.shift();
        if (this.activeQueue?.[0] === id) this.activeQueue.shift();
        await this.prepare(id);
      }
    } catch {
      this.paused = true;
      this.lastError =
        "Browser/runtime could not continue. Queue preserved; inspect the runtime terminal and Resume after resolving the issue.";
      log(this.lastError);
    } finally {
      this.busy = false;
      this.report();
    }
  }
  private async prepare(id: string) {
    let attemptId: string | undefined;
    try {
      this.profile = loadProfile(true);
      this.facts.importProfile(this.profile);
      const a = this.store.application(id),
        job = this.store.job(a.jobId);
      this.sessions.hosts.check(new URL(job.canonicalApplyUrl).hostname);
      attemptId = this.store.startAttempt(id, this.runId);
      const b = await this.sessions.get(id);
      b.resume();
      b.stage = "LANDING";
      if (!b.url().startsWith("https:"))
        await b.navigate(a.lastUrl ?? job.canonicalApplyUrl);
      b.beforeMutation = async () => {
        this.sessions.hosts.check(new URL(b.url()).hostname);
        for (const location of b.identityLocations()) {
          const destination = identify(location);
          const known = this.store.findIdentity(destination.fingerprint);
          if (known && known.id !== job.id)
            throw new SafetyStop(
              "Destination identity belongs to another application. Resolve duplicate identity.",
              "DUPLICATE",
            );
          if (!destination.atsJobId) continue;
          const original = this.store.job(job.id);
          if (
            original.atsJobId &&
            original.atsType === destination.atsType &&
            original.atsJobId !== destination.atsJobId
          )
            throw new SafetyStop(
              "Application requisition changed; confirm job identity.",
              "DUPLICATE",
            );
          this.store.db
            .insert(identityAliases)
            .values({ fingerprint: destination.fingerprint, jobId: job.id })
            .onConflictDoNothing()
            .run();
        }
      };
      await b.beforeMutation();
      const destination = identify(b.url()),
        known = this.store.findIdentity(destination.fingerprint);
      if (known && known.id !== job.id)
        throw new SafetyStop(
          "Destination identity belongs to another application. Resolve duplicate identity.",
          "DUPLICATE",
        );
      if (destination.atsJobId)
        this.store.db
          .insert(identityAliases)
          .values({ fingerprint: destination.fingerprint, jobId: job.id })
          .onConflictDoNothing()
          .run();
      const signature = await b.signature(),
        adapter = selectAdapter(signature, job.atsType);
      this.store.db
        .update(jobs)
        .set({
          atsType: adapter.type,
          atsJobId: destination.atsJobId ?? job.atsJobId,
          tenant: destination.atsJobId ? destination.tenant : job.tenant,
          updatedAt: now(),
        })
        .where(eq(jobs.id, job.id))
        .run();
      const provider = this.profile.ai?.enabled
        ? new CompatibleProvider(this.profile.ai, this.credentials)
        : undefined;
      const resolver = new AnswerResolver(
        this.facts,
        this.profile,
        provider ? (q, c) => provider.generate(q, c) : undefined,
      );
      const contextualFacts: Record<string, unknown> = {};
      for (const f of this.store.db
        .select()
        .from((await import("../db/schema.js")).facts)
        .all())
        if (
          !f.unknown &&
          f.scope === "global" &&
          /^experience\.|^education\./.test(f.canonicalKey)
        ) {
          const confirmed = this.facts.get(f.canonicalKey, f.scope);
          if (confirmed) contextualFacts[f.canonicalKey] = confirmed.parsed;
        }
      contextualFacts.education =
        this.facts.get("education.records")?.parsed ?? [];
      contextualFacts.employment =
        this.facts.get("employment.records")?.parsed ?? [];
      const resume = await verifiedResumeText(this.profile);
      if (resume) contextualFacts.verifiedResume = resume;
      const triggerAt = Date.now();
      const gmail = new GmailVerification(this.profile, this.credentials);
      const result = await adapter.prepare({
        browser: b,
        resolver,
        profile: this.profile,
        store: this.store,
        appId: id,
        generation: {
          company: job.company,
          role: job.role,
          description: signature.text,
          facts: contextualFacts,
        },
        authPermit: () => {
          const tenant = this.store.job(job.id).tenant;
          if (this.authAttempts.has(tenant)) return false;
          this.authAttempts.add(tenant);
          return true;
        },
        password: () => this.credentials.get("ats-default-password"),
        verify: async (browser) => {
          try {
            const tenant = this.store.job(job.id).tenant,
              origin = new URL(browser.url()).origin,
              trusted = [
                origin,
                ...(this.profile.gmail?.trustedOrigins[tenant] ?? []),
              ];
            const expectedSenders = verificationSenders(adapter.type);
            const candidate = await gmail.find({
              tenant,
              email: this.profile.personal.email,
              company: job.company,
              ats: adapter.type,
              triggeredAt: triggerAt,
              trustedOrigins: trusted,
              expectedSenders,
            });
            if (!candidate) return false;
            if (candidate.link)
              await browser.navigateVerification(candidate.link, trusted);
            else if (candidate.code)
              await browser.verificationCode(candidate.code);
            else return false;
            if (!trusted.includes(new URL(browser.url()).origin)) return false;
            return !/verify your email|verification code/i.test(
              await browser.text(),
            );
          } catch {
            return false;
          }
        },
        diagnose: async (reason, details) => {
          const filename = `${id}-${Date.now()}-diagnostic.json`;
          writeFileSync(
            artifactPath(filename),
            JSON.stringify(
              redact({ reason, detectedATS: adapter.type, details }),
              null,
              2,
            ),
            { mode: 0o600 },
          );
          this.store.event(
            id,
            "FORM_DIAGNOSTIC",
            "Private form diagnostic captured before unsupported-form fallback.",
            { artifact: filename, reason },
            this.runId,
          );
        },
      });
      if (result.reason?.includes("Security challenge"))
        this.sessions.hosts.challenge(new URL(b.url()).hostname);
      const redactedUrl = String(redact(b.url()));
      const lastUrl = redactedUrl.includes("[REDACTED]")
        ? job.canonicalApplyUrl
        : redactedUrl;
      this.store.transition(id, result.status, {
        stage: result.stage,
        attentionReason: result.reason,
        missingFields: JSON.stringify(result.missing),
        retryable: result.retryable,
        lastUrl,
        sessionAvailable: !b.isClosed(),
      });
      this.store.event(
        id,
        result.status,
        result.reason ?? "Application ready for human review.",
        {},
        this.runId,
      );
      await this.capture(id);
      b.takeOver();
      if (result.status === "SKIPPED") await this.sessions.close(id);
    } catch (e) {
      const a = this.store.application(id);
      if (a.status === "SUBMITTED") return;
      const takeover = e instanceof SafetyStop && e.reason === "TAKEOVER";
      const safety = e instanceof SafetyStop;
      const msg = takeover
        ? "Human takeover; Resume when finished."
        : safety
          ? e.message
          : "Preparation failed. Review diagnostics and Resume if appropriate.";
      if (a.status === "PROCESSING" || a.status === "QUEUED")
        this.store.transition(id, safety ? "NEEDS_REVIEW" : "SKIPPED", {
          attentionReason: msg,
          retryable: !safety,
          stage: a.stage,
        });
      if (this.runId)
        this.store.db
          .update(runs)
          .set({
            errorCount:
              (this.store.db
                .select()
                .from(runs)
                .where(eq(runs.id, this.runId))
                .get()?.errorCount ?? 0) + 1,
          })
          .where(eq(runs.id, this.runId))
          .run();
      this.store.event(
        id,
        "EXCEPTION",
        msg,
        { category: safety ? e.reason : "TECHNICAL" },
        this.runId,
      );
      await this.capture(id).catch(() => undefined);
      this.sessions.takeOver(id);
      if (!safety) await this.sessions.close(id).catch(() => undefined);
    } finally {
      if (attemptId)
        this.store.finishAttempt(attemptId, this.store.application(id).status);
    }
  }
  private async capture(id: string) {
    if (!this.sessions.has(id)) return;
    const b = await this.sessions.get(id),
      name = `${id}-${Date.now()}.png`;
    await b.screenshot(artifactPath(name));
    if (existsSync(artifactPath(name)))
      this.store.update(id, { screenshotPath: name });
  }
  report() {
    const list = this.store.list();
    const summary = {
      READY: list.filter((x) => x.application.status === "READY").length,
      NEEDS_REVIEW: list.filter((x) => x.application.status === "NEEDS_REVIEW")
        .length,
      SKIPPED: list.filter((x) => x.application.status === "SKIPPED").length,
      SUBMITTED: list.filter((x) => x.application.status === "SUBMITTED")
        .length,
      QUEUED: this.store.queue().length,
    };
    notify(summary, this.paused);
    log(
      this.paused
        ? "Run paused; clear review tabs then Continue."
        : "Application preparation complete",
      summary,
    );
    if (this.runId) {
      const outcomes = this.store.db
        .select()
        .from(events)
        .where(eq(events.runId, this.runId))
        .all();
      const count = (status: string) =>
        new Set(
          outcomes
            .filter((e) => e.eventType === status)
            .map((e) => e.applicationId),
        ).size;
      this.store.db
        .update(runs)
        .set({
          finishedAt: now(),
          readyCount: count("READY"),
          needsReviewCount: count("NEEDS_REVIEW"),
          skippedCount: count("SKIPPED"),
          submittedCount: count("SUBMITTED"),
          deferredCount:
            this.deferredByLimit +
            (this.activeQueue
              ? this.activeQueue.filter(
                  (id) => this.store.application(id).status === "QUEUED",
                ).length
              : summary.QUEUED),
        })
        .where(eq(runs.id, this.runId))
        .run();
    }
  }
  resolveQuestion(
    questionId: string,
    value: unknown,
    saveFact = true,
    correct = false,
  ) {
    const q = this.store.db
      .select()
      .from(unresolved)
      .where(eq(unresolved.id, questionId))
      .get();
    if (!q) throw new Error("Question not found");
    if (humanOnly(q.question))
      throw new Error(
        "Enter sensitive identifiers/attestations directly in the employer form",
      );
    const app = this.store.application(q.applicationId);
    if (app.status === "SUBMITTED")
      throw new Error("Application already submitted");
    const mapping = mapQuestion(q.question);
    const key = q.canonicalKey ?? mapping?.key;
    if (saveFact && key) {
      let factValue = value;
      if (
        key &&
        /^experience\..*Years$/.test(key) &&
        typeof value === "string" &&
        /^\d+(?:\.\d+)?$/.test(value.trim())
      )
        factValue = Number(value);
      if (mapping?.transform === "usCitizen") {
        if (value === true || value === "Yes") factValue = "United States";
        else
          throw new Error(
            "A No answer does not identify citizenship. Save this application-only, or enter country of citizenship in Facts.",
          );
      }
      if (mapping?.transform === "sponsorshipCombined")
        throw new Error(
          "Set present/future sponsorship facts separately; combined answers cannot establish both facts.",
        );
      this.facts.set(key, factValue, {
        scope: q.scope,
        correct,
        source: correct ? "HUMAN_CORRECTED" : "HUMAN_CONFIRMED",
      });
    }
    this.store.db
      .update(unresolved)
      .set({ answer: JSON.stringify(value), resolved: true })
      .where(eq(unresolved.id, q.id))
      .run();
    this.store.db
      .insert(answerHistory)
      .values({
        id: randomUUID(),
        applicationId: app.id,
        normalizedQuestion: normalize(q.question),
        originalQuestion: q.question,
        answer: typeof value === "string" ? value : JSON.stringify(value),
        answerSource: "HUMAN",
        generated: false,
        createdAt: now(),
      })
      .run();
    this.store.event(
      app.id,
      "HUMAN_ANSWER",
      "Human resolved a question; Resume to insert it.",
    );
    return { savedFact: !!(saveFact && key), needsAlias: !key };
  }
  async shutdown() {
    this.stopping = true;
    await this.sessions.shutdown();
    await this.workerTask;
    this.store.close();
  }
}
function verificationSenders(ats: string) {
  return (
    (
      {
        workday: ["myworkday.com", "myworkdayjobs.com"],
        greenhouse: ["greenhouse.io"],
        ashby: ["ashbyhq.com"],
        icims: ["icims.com"],
        oracle: ["oraclecloud.com"],
      } as Record<string, string[]>
    )[ats] ?? []
  );
}
export function acquireLock() {
  const file = join(paths.data, "runtime.lock");
  if (existsSync(file)) {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    try {
      process.kill(lock.pid, 0);
      throw new Error("Another runtime owns the browser/database.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    unlinkSync(file);
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  return () => {
    if (existsSync(file)) unlinkSync(file);
  };
}
