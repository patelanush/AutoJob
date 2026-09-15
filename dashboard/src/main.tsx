import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Application = {
  id: string;
  status: string;
  stage: string;
  attentionReason: string | null;
  missingFields: string;
  updatedAt: string;
  revision: number;
  sessionAvailable: boolean;
  screenshotPath: string | null;
};
type Job = {
  id: string;
  company: string;
  role: string;
  locationRaw: string;
  canonicalApplyUrl: string;
  atsType: string;
  sourceAgeDays: number | null;
};
type Row = { application: Application; job: Job; aiCount: number };
type Fact = {
  id: string;
  canonicalKey: string;
  scope: string;
  value: string | null;
  source: string;
  stability: string;
  lastConfirmedAt: string;
  usedCount: number;
  revision: number;
  unknown: boolean;
  notes?: string | null;
};
type Detail = {
  application: Application;
  job: Job;
  events: { id: string; timestamp: string; stage: string; message: string }[];
  answers: {
    id: string;
    originalQuestion: string;
    answer: string;
    answerSource: string;
    generated: boolean;
  }[];
  questions: {
    id: string;
    question: string;
    choices: string;
    reason: string;
    resolved: boolean;
    canonicalKey: string | null;
    scope: string;
  }[];
  attempts: { id: string; startedAt: string; outcome: string }[];
};
type Correction = {
  question: string;
  previousAnswer: string;
  newAnswer: string;
  canonicalKey: string | null;
  scope: string;
};
type Status = {
  busy: boolean;
  paused: boolean;
  retained: number;
  limit: number;
  queued: number;
  lastError?: string | null;
  feedExceptions?: {
    company: string;
    role: string;
    category: string;
    reason: string;
  }[];
  lastRun?: {
    startedAt: string;
    discoveredCount: number;
    queuedCount: number;
    alreadyKnownCount: number;
  };
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (body !== undefined) {
    const { csrf } = await (await fetch("/api/session")).json();
    headers["x-csrf-token"] = csrf;
  }
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
const display = (s: string) => s.replaceAll("_", " ").toLowerCase();
const time = (s: string) => new Date(s).toLocaleString();
function App() {
  const [rows, setRows] = useState<Row[]>([]),
    [facts, setFacts] = useState<Fact[]>([]),
    [status, setStatus] = useState<Status>(),
    [filter, setFilter] = useState("ALL"),
    [page, setPage] = useState("Applications"),
    [detail, setDetail] = useState<Detail>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [corrections, setCorrections] = useState<Correction[]>([]),
    [aliasQuestion, setAliasQuestion] = useState(""),
    [search, setSearch] = useState("");
  const [newFact, setNewFact] = useState(false),
    [edit, setEdit] = useState<Fact>(),
    [factKey, setFactKey] = useState(""),
    [factValue, setFactValue] = useState(""),
    [factScope, setFactScope] = useState("global"),
    [factStability, setFactStability] = useState("SLOW_CHANGING"),
    [history, setHistory] = useState(false),
    [priorUrl, setPriorUrl] = useState(""),
    [priorCompany, setPriorCompany] = useState(""),
    [priorRole, setPriorRole] = useState("");
  async function refresh() {
    try {
      const [r, f, s] = await Promise.all([
        request<Row[]>("/applications"),
        request<Fact[]>("/facts"),
        request<Status>("/status"),
      ]);
      setRows(r);
      setFacts(f);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  async function action(path: string, body: unknown = {}) {
    try {
      setError("");
      await request(path, body);
      await refresh();
      if (detail)
        setDetail(
          await request<Detail>(`/applications/${detail.application.id}`),
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function editing(f?: Fact) {
    setEdit(f);
    setFactKey(f?.canonicalKey ?? "");
    setFactValue(f?.value ?? "");
    setFactScope(f?.scope ?? "global");
    setFactStability(f?.stability ?? "SLOW_CHANGING");
    setAliasQuestion("");
    setNewFact(true);
  }
  const visible = rows.filter(
    (r) =>
      (filter === "ALL" || r.application.status === filter) &&
      `${r.job.company} ${r.job.role} ${r.application.attentionReason ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const counts = (s: string) =>
    rows.filter((r) => r.application.status === s).length;
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/">
          ◈{" "}
          <span>
            Application
            <br />
            Desk
          </span>
        </a>
        <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
        {["Applications", "My Application Facts"].map((p) => (
          <button
            key={p}
            className={"nav " + (page === p ? "selected" : "")}
            onClick={() => setPage(p)}
          >
            {p === "Applications" ? "▤" : "◇"} {p}
          </button>
        ))}
        <div className="safety">
          <span className="dot" /> Human submission only
          <p>
            Preparation runs locally.
            <br />
            The final Submit is always yours.
          </p>
        </div>
        <div className="aside-bottom">
          LOCALHOST · SINGLE USER
          <br />
          No cloud dashboard
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">LESS REPETITION. MORE MOMENTUM.</p>
            <h1>
              {page === "Applications"
                ? "Your application queue"
                : "My Application Facts"}
            </h1>
            <p className="muted">
              {page === "Applications"
                ? "Prepared for your review, one application at a time."
                : "Answers you confirm once, remembered with the right scope."}
            </p>
          </div>
          <div className="header-actions">
            <span className="local">
              <span className="dot" /> Local & private
            </span>
            <button onClick={() => setHistory(true)}>
              ＋ Record prior application
            </button>
            {page === "Applications" && (
              <button
                className="primary"
                disabled={status?.busy}
                onClick={() => void action("/run", { lookback: 7 })}
              >
                {status?.busy ? "Preparing…" : "Prepare new jobs"}
              </button>
            )}
          </div>
        </header>
        {status?.lastError && <div className="alert">{status.lastError}</div>}
        {!!status?.feedExceptions?.length && (
          <div className="alert">
            <strong>Feed rows need a direct employer link</strong>
            {status.feedExceptions.map((j, i) => (
              <p key={i}>
                {j.company} — {j.role}: {j.reason}
              </p>
            ))}
          </div>
        )}
        {error && (
          <div className="alert">
            <strong>Action needs attention</strong>
            <p>{error}</p>
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {notice && (
          <div className="notice" onClick={() => setNotice("")}>
            {notice}
          </div>
        )}
        {page === "Applications" ? (
          <>
            <section className="summary">
              {[
                ["Ready to submit", counts("READY"), "green"],
                ["Needs your review", counts("NEEDS_REVIEW"), "amber"],
                ["Skipped", counts("SKIPPED"), "muted"],
                ["Submitted", counts("SUBMITTED"), "blue"],
              ].map(([label, value, color]) => (
                <div className="metric" key={label}>
                  <span>{label}</span>
                  <strong className={String(color)}>{value}</strong>
                  <small>
                    {label === "Ready to submit"
                      ? "Review, then press Submit"
                      : label === "Needs your review"
                        ? "Specific next steps below"
                        : label === "Submitted"
                          ? "Permanently out of the queue"
                          : "Reasons saved in details"}
                  </small>
                </div>
              ))}
            </section>
            <section className="runline">
              <div>
                <span className="dot" />{" "}
                {status?.busy
                  ? "Worker preparing applications"
                  : status?.paused
                    ? "Paused at review capacity"
                    : "Worker idle"}
              </div>
              <span>{status?.retained ?? 0} / 10 review tabs</span>
              <span>{status?.queued ?? 0} queued</span>
              <span>Window: 0–7 days</span>
              {status?.paused && (
                <button
                  className="primary"
                  onClick={() => void action("/continue")}
                >
                  Continue queue
                </button>
              )}
            </section>
            <p className="run-detail">
              {status?.lastRun
                ? `Last run ${time(status.lastRun.startedAt)} · ${status.lastRun.discoveredCount} eligible rows · ${status.lastRun.queuedCount} new jobs · ${status.lastRun.alreadyKnownCount} already known`
                : "No runs yet. Configure your private profile, then prepare new jobs."}
            </p>
            <section className="table-panel">
              <div className="toolbar">
                <div className="tabs">
                  {["ALL", "READY", "NEEDS_REVIEW", "SKIPPED", "SUBMITTED"].map(
                    (f) => (
                      <button
                        key={f}
                        className={filter === f ? "active" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {display(f)}
                      </button>
                    ),
                  )}
                </div>
                <input
                  aria-label="Search applications"
                  placeholder="Search company, role, or exception…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Company / role</th>
                      <th>Location / age</th>
                      <th>ATS</th>
                      <th>Status / stage</th>
                      <th>What you need to do</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(({ application: a, job: j, aiCount }) => (
                      <tr key={a.id}>
                        <td>
                          <strong>{j.company}</strong>
                          <p>{j.role}</p>
                          {aiCount > 0 && (
                            <span className="ai">
                              ✦ {aiCount} AI answer{aiCount > 1 ? "s" : ""}
                            </span>
                          )}
                          <small>Updated {time(a.updatedAt)}</small>
                        </td>
                        <td>
                          {j.locationRaw}
                          <small>{j.sourceAgeDays ?? "?"}d in source</small>
                        </td>
                        <td>
                          <span className="ats">{j.atsType}</span>
                        </td>
                        <td>
                          <span className={"badge " + a.status.toLowerCase()}>
                            {display(a.status)}
                          </span>
                          <small>
                            {display(a.stage)}
                            {!a.sessionAvailable && a.status !== "SUBMITTED"
                              ? " · tab unavailable"
                              : ""}
                          </small>
                        </td>
                        <td className="attention">
                          {a.attentionReason ??
                            (a.status === "READY"
                              ? "Review your answers and submit."
                              : "—")}
                        </td>
                        <td>
                          <div className="row-actions">
                            {a.status !== "SUBMITTED" && (
                              <button
                                onClick={() =>
                                  void action(`/applications/${a.id}/open`)
                                }
                              >
                                Open ↗
                              </button>
                            )}
                            <button
                              onClick={() =>
                                void request<Detail>(`/applications/${a.id}`)
                                  .then(setDetail)
                                  .catch((e) => setError(String(e)))
                              }
                            >
                              Details
                            </button>
                            <button
                              title="Copy direct link"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(j.canonicalApplyUrl)
                                  .then(() =>
                                    setNotice("Direct employer link copied."),
                                  )
                              }
                            >
                              Copy link
                            </button>
                            {["READY", "NEEDS_REVIEW"].includes(a.status) && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  if (
                                    confirm(
                                      "Confirm that you manually submitted this application? Its tab will close.",
                                    )
                                  )
                                    void action(
                                      `/applications/${a.id}/submitted`,
                                    );
                                }}
                              >
                                Mark submitted
                              </button>
                            )}
                            {["READY", "NEEDS_REVIEW", "SKIPPED"].includes(
                              a.status,
                            ) && (
                              <button
                                className="text-button"
                                onClick={() =>
                                  void action(`/applications/${a.id}/resume`, {
                                    humanResolved:
                                      a.status === "SKIPPED" &&
                                      confirm(
                                        "Have you opened this application and resolved its blocker normally? This does not override host safety limits.",
                                      ),
                                  })
                                }
                              >
                                Retry / Resume
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visible.length && (
                  <div className="empty">
                    <div>◇</div>
                    <h2>
                      {rows.length
                        ? "No applications match this view"
                        : "A clear desk. A fresh start."}
                    </h2>
                    <p>
                      Use dry-run to inspect the feed. Your prepared
                      applications will appear here.
                    </p>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : (
          <>
            <div className="facts-intro">
              <p>
                Edits affect future answers immediately. Conflicts require an
                explicit correction; prepared applications using changed facts
                need review.
              </p>
              <button className="primary" onClick={() => editing()}>
                ＋ Add approved fact
              </button>
            </div>
            <section className="table-panel">
              <table>
                <thead>
                  <tr>
                    <th>Canonical fact</th>
                    <th>Value</th>
                    <th>Scope / stability</th>
                    <th>Source / confirmed</th>
                    <th>Used</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <strong>{f.canonicalKey}</strong>
                        {f.notes?.startsWith("PROFILE_CONFLICT:") && (
                          <small className="amber">{f.notes}</small>
                        )}
                      </td>
                      <td>
                        {f.unknown ? (
                          <span className="muted">Unknown</span>
                        ) : (
                          f.value
                        )}
                      </td>
                      <td>
                        {f.scope}
                        <small>{display(f.stability)}</small>
                      </td>
                      <td>
                        {display(f.source)}
                        <small>{time(f.lastConfirmedAt)}</small>
                      </td>
                      <td>{f.usedCount}</td>
                      <td>
                        <button onClick={() => editing(f)}>
                          Edit / Correct
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                "Mark unknown and prevent automatic reuse?",
                              )
                            )
                              void action(`/facts/${f.id}/unknown`, {
                                revision: f.revision,
                              });
                          }}
                        >
                          Delete / Mark unknown
                        </button>
                        <button
                          onClick={() =>
                            void request(`/facts/${f.id}/history`).then((h) =>
                              alert(JSON.stringify(h, null, 2)),
                            )
                          }
                        >
                          History
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!facts.length && (
                <div className="empty">
                  <h2>Your knowledge base starts here.</h2>
                  <p>
                    Add approved facts or answer a reusable question in
                    application details.
                  </p>
                </div>
              )}
            </section>
          </>
        )}
        <footer>
          Prepared safely. Submitted by you.{" "}
          <span>Application Desk · localhost only</span>
        </footer>
      </main>
      {detail && (
        <div className="overlay">
          <section className="drawer">
            <button className="close" onClick={() => setDetail(undefined)}>
              ✕
            </button>
            <p className="eyebrow">APPLICATION DETAILS</p>
            <h2>{detail.job.company}</h2>
            <p>
              {detail.job.role} · {detail.job.locationRaw}
            </p>
            <span
              className={"badge " + detail.application.status.toLowerCase()}
            >
              {display(detail.application.status)}
            </span>
            <div className="need">
              <h3>What I need to do</h3>
              <p>
                {detail.application.attentionReason ??
                  "Review the prepared application, then submit it yourself."}
              </p>
              <button
                className="primary"
                onClick={() =>
                  void action(`/applications/${detail.application.id}/open`)
                }
              >
                Open application ↗
              </button>
              <button
                onClick={() =>
                  void action(`/applications/${detail.application.id}/resume`, {
                    humanResolved:
                      detail.application.status === "SKIPPED" &&
                      confirm(
                        "Have you resolved the blocker normally in the application tab?",
                      ),
                  })
                }
              >
                Resume preparation
              </button>
            </div>
            <a
              href={detail.job.canonicalApplyUrl}
              target="_blank"
              rel="noreferrer"
            >
              Direct job link ↗
            </a>
            <h3>Unresolved questions</h3>
            {detail.questions
              .filter((q) => !q.resolved)
              .map((q) => (
                <QuestionAnswer
                  key={q.id}
                  question={q}
                  onSave={(value, saveFact) =>
                    void action(`/questions/${q.id}/answer`, {
                      value,
                      saveFact,
                    })
                  }
                />
              ))}
            {!detail.questions.some((q) => !q.resolved) && (
              <p className="muted">
                No stored unanswered questions. Other exceptions are described
                above.
              </p>
            )}
            <h3>Browser corrections</h3>
            <button
              onClick={() =>
                void request<Correction[]>(
                  `/applications/${detail.application.id}/corrections`,
                )
                  .then(setCorrections)
                  .catch((e) => setError(String(e)))
              }
            >
              Check browser corrections
            </button>
            {corrections.map((c) => (
              <article className="answer" key={c.question}>
                <strong>{c.question}</strong>
                <p>
                  {c.previousAnswer} → {c.newAnswer}
                </p>
                <button
                  onClick={() => {
                    const scope =
                      c.scope === "company"
                        ? `company:${detail.job.company
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, " ")
                            .trim()}`
                        : c.scope === "job"
                          ? `job:${detail.job.id}`
                          : "global";
                    const existing = facts.find(
                      (f) =>
                        f.canonicalKey === c.canonicalKey && f.scope === scope,
                    );
                    editing(existing);
                    setFactKey(c.canonicalKey ?? "");
                    setFactValue(c.newAnswer);
                    setFactScope(scope);
                    setAliasQuestion(c.question);
                  }}
                >
                  Review and save confirmed fact
                </button>
              </article>
            ))}
            <h3>Answer history</h3>
            {detail.answers.map((a) => (
              <article className="answer" key={a.id}>
                <strong>{a.originalQuestion}</strong>
                <span className={a.generated ? "ai" : "provenance"}>
                  {a.generated ? "✦ AI generated" : a.answerSource}
                </span>
                <p>{a.answer}</p>
                <button
                  onClick={() => {
                    setFactKey("");
                    setFactValue(JSON.stringify(a.answer));
                    setFactScope("global");
                    setEdit(undefined);
                    setAliasQuestion("");
                    setNewFact(true);
                  }}
                >
                  Save a confirmed correction as fact
                </button>
              </article>
            ))}
            <h3>Automation timeline</h3>
            {detail.events.map((e) => (
              <div className="event" key={e.id}>
                <small>
                  {time(e.timestamp)} · {e.stage}
                </small>
                <p>{e.message}</p>
              </div>
            ))}
            <h3>Attempts</h3>
            {detail.attempts.map((a) => (
              <p key={a.id}>
                {time(a.startedAt)} · {a.outcome ?? "In progress"}
              </p>
            ))}
            {detail.application.screenshotPath && (
              <>
                <h3>Private screenshot</h3>
                <img
                  className="screenshot"
                  src={`/api/artifacts/${detail.application.id}`}
                  alt="Last captured application state"
                />
              </>
            )}
            <button
              className="danger"
              onClick={() => {
                if (
                  confirm(
                    "Close this tab? Unsaved form data may be lost and recovery will require review.",
                  )
                )
                  void action(`/applications/${detail.application.id}/close`, {
                    confirm: true,
                  });
              }}
            >
              Close review tab
            </button>
          </section>
        </div>
      )}
      {newFact && (
        <div className="overlay">
          <section className="modal">
            <h2>{edit ? "Correct approved fact" : "Add approved fact"}</h2>
            <label>
              Canonical key
              <input
                value={factKey}
                onChange={(e) => setFactKey(e.target.value)}
                placeholder="experience.pythonYears"
                disabled={!!edit}
              />
            </label>
            <label>
              Value (JSON or plain text)
              <textarea
                value={factValue}
                onChange={(e) => setFactValue(e.target.value)}
                placeholder={'3, true, or "United States"'}
              />
            </label>
            <label>
              Scope
              <input
                value={factScope}
                onChange={(e) => setFactScope(e.target.value)}
                placeholder="global, company:google, or job:ID"
                disabled={!!edit}
              />
            </label>
            <label>
              Stability
              <select
                value={factStability}
                onChange={(e) => setFactStability(e.target.value)}
              >
                {["PERMANENT", "SLOW_CHANGING", "TEMPORARY"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Question alias (optional)
              <input
                value={aliasQuestion}
                onChange={(e) => setAliasQuestion(e.target.value)}
                placeholder="Exact question whose meaning this fact represents"
              />
            </label>
            <p className="muted">
              Never enter SSNs, government ID numbers, signatures,
              certifications, or consent here.
            </p>
            <div className="modal-actions">
              <button onClick={() => setNewFact(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  let value: unknown;
                  try {
                    value = JSON.parse(factValue);
                  } catch {
                    value = factValue;
                  }
                  void request("/facts", {
                    key: factKey,
                    value,
                    scope: factScope,
                    stability: factStability,
                    correct: !!edit,
                    revision: edit?.revision,
                  })
                    .then(async () => {
                      if (aliasQuestion)
                        await request("/aliases", {
                          question: aliasQuestion,
                          key: factKey,
                          scope: factScope,
                        });
                      setNewFact(false);
                      void refresh();
                    })
                    .catch((e) => setError(String(e)));
                }}
              >
                Confirm and save
              </button>
            </div>
          </section>
        </div>
      )}
      {history && (
        <div className="overlay">
          <section className="modal">
            <h2>Record a prior submission</h2>
            <p>Prevent this exact job from being prepared again.</p>
            <label>
              Direct application URL
              <input
                value={priorUrl}
                onChange={(e) => setPriorUrl(e.target.value)}
              />
            </label>
            <label>
              Company
              <input
                value={priorCompany}
                onChange={(e) => setPriorCompany(e.target.value)}
              />
            </label>
            <label>
              Role
              <input
                value={priorRole}
                onChange={(e) => setPriorRole(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setHistory(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() =>
                  void request("/history", {
                    url: priorUrl,
                    company: priorCompany,
                    role: priorRole,
                  })
                    .then(() => {
                      setHistory(false);
                      void refresh();
                    })
                    .catch((e) => setError(String(e)))
                }
              >
                Record as submitted
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function QuestionAnswer({
  question: q,
  onSave,
}: {
  question: Detail["questions"][number];
  onSave: (v: unknown, save: boolean) => void;
}) {
  const [value, setValue] = useState(""),
    [save, setSave] = useState(!!q.canonicalKey);
  const choices = JSON.parse(q.choices) as string[];
  return (
    <article className="question">
      <strong>{q.question}</strong>
      <p className="muted">{q.reason}</p>
      {choices.length ? (
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose an answer</option>
          {choices.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your confirmed answer"
        />
      )}
      {q.canonicalKey && (
        <label className="check">
          <input
            type="checkbox"
            checked={save}
            onChange={(e) => setSave(e.target.checked)}
          />
          Remember as {q.canonicalKey} ({q.scope})
        </label>
      )}
      <button
        onClick={() =>
          onSave(
            /^(yes|no)$/i.test(value) ? value.toLowerCase() === "yes" : value,
            save,
          )
        }
        disabled={!value}
      >
        Save answer
      </button>
      {!q.canonicalKey && (
        <p className="muted">
          Saved for this application. Add a scoped fact and alias to reuse it
          elsewhere.
        </p>
      )}
    </article>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
