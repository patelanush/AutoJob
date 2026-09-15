import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
const id = () => text("id").primaryKey();
export const jobs = sqliteTable("jobs", {
  id: id(),
  fingerprint: text("fingerprint").notNull().unique(),
  source: text("source").notNull(),
  sourceCategory: text("source_category").notNull(),
  company: text("company").notNull(),
  role: text("role").notNull(),
  locationRaw: text("location_raw").notNull(),
  originalApplyUrl: text("original_apply_url").notNull(),
  canonicalApplyUrl: text("canonical_apply_url").notNull(),
  simplifyUrl: text("simplify_url"),
  atsType: text("ats_type").notNull(),
  atsJobId: text("ats_job_id"),
  tenant: text("tenant").notNull(),
  sourceAgeDays: integer("source_age_days"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  approximatePostedAt: text("approximate_posted_at"),
  isClosed: integer("is_closed", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const applications = sqliteTable("applications", {
  id: id(),
  jobId: text("job_id")
    .notNull()
    .unique()
    .references(() => jobs.id),
  status: text("status").notNull(),
  stage: text("stage").notNull(),
  attentionReason: text("attention_reason"),
  missingFields: text("missing_fields").notNull().default("[]"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"),
  startedAt: text("started_at"),
  preparedAt: text("prepared_at"),
  submittedAt: text("submitted_at"),
  lastUrl: text("last_url"),
  retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
  screenshotPath: text("screenshot_path"),
  notes: text("notes"),
  sessionAvailable: integer("session_available", { mode: "boolean" })
    .notNull()
    .default(false),
  revision: integer("revision").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const runs = sqliteTable("runs", {
  id: id(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  lookbackDays: integer("lookback_days").notNull(),
  discoveredCount: integer("discovered_count").notNull().default(0),
  queuedCount: integer("queued_count").notNull().default(0),
  readyCount: integer("ready_count").notNull().default(0),
  needsReviewCount: integer("needs_review_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  submittedCount: integer("submitted_count").notNull().default(0),
  alreadyKnownCount: integer("already_known_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  deferredCount: integer("deferred_count").notNull().default(0),
});
export const events = sqliteTable("application_events", {
  id: id(),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id),
  runId: text("run_id"),
  timestamp: text("timestamp").notNull(),
  stage: text("stage").notNull(),
  eventType: text("event_type").notNull(),
  message: text("message").notNull(),
  metadata: text("metadata").notNull().default("{}"),
});
export const attempts = sqliteTable("application_attempts", {
  id: id(),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id),
  runId: text("run_id"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  lastHeartbeatAt: text("last_heartbeat_at").notNull(),
  outcome: text("outcome"),
});
export const siteAccounts = sqliteTable("site_accounts", {
  id: id(),
  tenant: text("tenant").notNull().unique(),
  email: text("email").notNull(),
  credentialRef: text("credential_ref"),
  createdAt: text("created_at").notNull(),
  verifiedAt: text("verified_at"),
  lastSuccessfulLoginAt: text("last_successful_login_at"),
  notes: text("notes"),
});
export const answerHistory = sqliteTable("answer_history", {
  id: id(),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id),
  normalizedQuestion: text("normalized_question").notNull(),
  originalQuestion: text("original_question").notNull(),
  answer: text("answer").notNull(),
  answerSource: text("answer_source").notNull(),
  generated: integer("generated", { mode: "boolean" }).notNull(),
  factKey: text("fact_key"),
  factRevision: integer("fact_revision"),
  createdAt: text("created_at").notNull(),
});
export const facts = sqliteTable(
  "facts",
  {
    id: id(),
    canonicalKey: text("canonical_key").notNull(),
    scope: text("scope").notNull(),
    value: text("value"),
    valueType: text("value_type").notNull(),
    source: text("source").notNull(),
    stability: text("stability").notNull(),
    confidence: real("confidence").notNull().default(1),
    firstConfirmedAt: text("first_confirmed_at").notNull(),
    lastConfirmedAt: text("last_confirmed_at").notNull(),
    expiresAt: text("expires_at"),
    notes: text("notes"),
    usedCount: integer("used_count").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    unknown: integer("unknown", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("fact_scope_unique").on(t.canonicalKey, t.scope)],
);
export const factHistory = sqliteTable("fact_history", {
  id: id(),
  factId: text("fact_id")
    .notNull()
    .references(() => facts.id),
  before: text("before"),
  after: text("after"),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
});
export const aliases = sqliteTable(
  "question_aliases",
  {
    id: id(),
    normalizedQuestion: text("normalized_question").notNull(),
    canonicalFactKey: text("canonical_fact_key").notNull(),
    scope: text("scope").notNull(),
    ats: text("ats"),
    company: text("company"),
    confidence: real("confidence").notNull(),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("alias_scope_unique").on(t.normalizedQuestion, t.scope)],
);
export const unresolved = sqliteTable("unresolved_questions", {
  id: id(),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id),
  question: text("question").notNull(),
  choices: text("choices").notNull().default("[]"),
  canonicalKey: text("canonical_key"),
  scope: text("scope").notNull(),
  reason: text("reason").notNull(),
  answer: text("answer"),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});
export const identityAliases = sqliteTable("job_identity_aliases", {
  fingerprint: text("fingerprint").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
});
export const observations = sqliteTable("source_observations", {
  observationKey: text("observation_key").primaryKey(),
  company: text("company").notNull(),
  role: text("role").notNull(),
  category: text("category").notNull(),
  isClosed: integer("is_closed", { mode: "boolean" }).notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});
