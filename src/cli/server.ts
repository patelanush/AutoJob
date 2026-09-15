import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { Runtime } from "../runs/runtime.js";
import { runs, facts, factHistory } from "../db/schema.js";
import { root } from "../config/profile.js";
import { artifactPath } from "../security/privacy.js";
import { identify } from "../feed/identity.js";
const idParams = z.object({ id: z.string().uuid() });
export async function createAPI(runtime: Runtime, port = 4317) {
  const app = Fastify({ logger: false, bodyLimit: 100000 }),
    csrf = randomBytes(32).toString("hex");
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    if (!host || !new RegExp(`^127\\.0\\.0\\.1:${port}$`).test(host)) {
      reply.code(403).send({ error: "Invalid local Host" });
      return;
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.headers.origin !== `http://127.0.0.1:${port}` ||
        req.headers["x-csrf-token"] !== csrf)
    ) {
      reply
        .code(403)
        .send({ error: "Same-origin CSRF protection rejected request" });
    }
  });
  app.setErrorHandler((error, _, reply) =>
    reply.code(400).send({
      error: error instanceof Error ? error.message : "Request failed",
    }),
  );
  app.get("/api/session", () => ({ csrf }));
  app.get("/api/status", () => ({
    busy: runtime.busy,
    paused: runtime.paused,
    lastError: runtime.lastError,
    feedExceptions: runtime.feedExceptions,
    retained: runtime.sessions.retained(),
    limit: 10,
    lastRun: runtime.store.db
      .select()
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .get(),
    queued: runtime.store.queue().length,
  }));
  app.get("/api/applications", () => runtime.store.list());
  app.get("/api/applications/:id", (req) =>
    runtime.store.details(idParams.parse(req.params).id),
  );
  app.get("/api/applications/:id/corrections", async (req) => {
    const id = idParams.parse(req.params).id;
    if (!runtime.sessions.has(id)) return [];
    const { findBrowserCorrections } =
      await import("../answers/corrections.js");
    return findBrowserCorrections(
      runtime.store,
      id,
      await runtime.sessions.get(id),
    );
  });
  app.post("/api/applications/:id/open", async (req) => {
    await runtime.sessions.focus(idParams.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/applications/:id/submitted", async (req) => {
    await runtime.submitted(idParams.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/applications/:id/resume", async (req) => {
    const body = z
      .object({ humanResolved: z.boolean().default(false) })
      .parse(req.body);
    await runtime.retry(idParams.parse(req.params).id, body.humanResolved);
    return { ok: true };
  });
  app.post("/api/applications/:id/close", async (req) => {
    const { confirm } = z.object({ confirm: z.literal(true) }).parse(req.body);
    void confirm;
    await runtime.sessions.close(idParams.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/run", async (req) =>
    runtime.ingest(
      z
        .object({ lookback: z.number().int().min(0).max(30).default(7) })
        .parse(req.body).lookback,
    ),
  );
  app.post("/api/continue", () => {
    runtime.continue();
    return { ok: true };
  });
  app.post("/api/questions/:id/answer", (req) => {
    const body = z
      .object({
        value: z.unknown(),
        saveFact: z.boolean().default(true),
        correct: z.boolean().default(false),
      })
      .parse(req.body);
    return runtime.resolveQuestion(
      idParams.parse(req.params).id,
      body.value,
      body.saveFact,
      body.correct,
    );
  });
  app.get("/api/facts", () => runtime.store.db.select().from(facts).all());
  app.get("/api/facts/:id/history", (req) =>
    runtime.store.db
      .select()
      .from(factHistory)
      .where(eq(factHistory.factId, idParams.parse(req.params).id))
      .all(),
  );
  app.post("/api/facts", (req) => {
    const b = z
      .object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]+$/),
        value: z.unknown(),
        scope: z.string().default("global"),
        stability: z
          .enum(["PERMANENT", "SLOW_CHANGING", "TEMPORARY"])
          .optional(),
        expiresAt: z.iso.datetime().optional(),
        correct: z.boolean().default(false),
        revision: z.number().int().optional(),
      })
      .parse(req.body);
    const id = runtime.facts.set(b.key, b.value, {
      scope: b.scope,
      stability: b.stability,
      expiresAt: b.expiresAt,
      correct: b.correct,
      revision: b.revision,
      source: b.correct ? "HUMAN_CORRECTED" : "HUMAN_CONFIRMED",
    });
    return { id };
  });
  app.post("/api/facts/:id/unknown", (req) => {
    const b = z.object({ revision: z.number().int() }).parse(req.body);
    runtime.facts.unknown(idParams.parse(req.params).id, b.revision);
    return { ok: true };
  });
  app.post("/api/aliases", (req) => {
    const b = z
      .object({
        question: z.string(),
        key: z.string(),
        scope: z.string().default("global"),
        ats: z.string().optional(),
      })
      .parse(req.body);
    runtime.facts.alias(b.question, b.key, b.scope, b.ats);
    return { ok: true };
  });
  app.post("/api/history", async (req) => {
    const b = z
        .object({
          url: z.url(),
          company: z.string(),
          role: z.string(),
          location: z.string().default(""),
        })
        .parse(req.body),
      identity = identify(b.url);
    const existing = runtime.store.findIdentity(identity.fingerprint);
    if (existing) {
      const entry = runtime.store.list().find((a) => a.job.id === existing.id);
      if (entry) {
        await runtime.submitted(entry.application.id);
        return { id: entry.application.id };
      }
    }
    runtime.store.ingest(
      [
        {
          company: b.company,
          role: b.role,
          category: "Historical",
          locationRaw: b.location,
          originalApplyUrl: b.url,
          simplifyUrl: null,
          ageDays: 0,
          isClosed: false,
          observationKey: identity.fingerprint,
          identity,
        },
      ],
      7,
    );
    const entry = runtime.store
      .list()
      .find((a) => a.job.fingerprint === identity.fingerprint)!;
    runtime.store.transition(entry.application.id, "SUBMITTED", {
      notes: "Human-recorded prior application",
    });
    runtime.store.event(
      entry.application.id,
      "HISTORICAL",
      "Human recorded a prior submission.",
    );
    return { id: entry.application.id };
  });
  app.get("/api/artifacts/:id", async (req, reply) => {
    const a = runtime.store.application(idParams.parse(req.params).id);
    if (!a.screenshotPath)
      return reply.code(404).send({ error: "Artifact unavailable" });
    const file = artifactPath(a.screenshotPath);
    return reply.type("image/png").send(readFileSync(file));
  });
  const dist = join(root, "dist/dashboard");
  if (existsSync(join(dist, "index.html"))) {
    await app.register(staticPlugin, { root: dist, list: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  } else
    app.get("/", (_, reply) =>
      reply
        .type("text/html")
        .send(
          "<h1>Job Apply Agent</h1><p>Build the dashboard with <code>npm run build</code>, then restart this runtime.</p>",
        ),
    );
  return app;
}
