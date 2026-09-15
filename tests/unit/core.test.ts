import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { profileSchema } from "../../src/config/profile.js";
import { parseFeed, ageDays, eligible } from "../../src/feed/parser.js";
import { canonicalize, identify } from "../../src/feed/identity.js";
import {
  parseAtsType,
  parseLimit,
  planFeedSelection,
} from "../../src/feed/selection.js";
import { Store, canTransition } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
import {
  AnswerResolver,
  mapQuestion,
  mapValue,
  humanOnly,
} from "../../src/answers/resolver.js";
import {
  authorizeAction,
  fieldValueMatches,
  isFinalAction,
} from "../../src/browser/actions.js";
import { redact, safeUrl } from "../../src/security/privacy.js";
import { HostSafety } from "../../src/browser/hosts.js";
import { chooseVerification } from "../../src/verification/gmail.js";
import {
  validateGenerated,
  CompatibleProvider,
} from "../../src/llm/provider.js";
const profile = profileSchema.parse(
  JSON.parse(readFileSync("profile.example.json", "utf8")),
);
export const feed = `## Software Engineering\n<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead><tbody><tr><td><strong>Acme</strong></td><td>Engineer</td><td>Phoenix<br/>New York</td><td><a href="https://boards.greenhouse.io/acme/jobs/123?gh_jid=123&utm_source=Simplify">Apply</a><a href="https://simplify.jobs/p/abc">Simplify</a></td><td>0d</td></tr><tr><td>↳</td><td>Engineer</td><td>New York</td><td><a href="https://boards.greenhouse.io/acme/jobs/124">Apply</a></td><td>7d</td></tr><tr><td>↳</td><td>Old</td><td>Phoenix</td><td>🔒</td><td>6d</td></tr></tbody></table>\n## Hardware Engineering\n<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead><tbody><tr><td>Other</td><td>Hardware</td><td>AZ</td><td><a href="https://example.com/jobs/99">Apply</a></td><td>1mo</td></tr></tbody></table>`;
function makeStore() {
  const s = new Store(":memory:");
  s.ingest(parseFeed(feed).jobs, 7);
  return s;
}
describe("feed parser", () => {
  it("parses all categories and continuation companies", () => {
    const { jobs } = parseFeed(feed);
    expect(jobs).toHaveLength(4);
    expect(jobs[1].company).toBe("Acme");
    expect(jobs[3].category).toBe("Hardware Engineering");
  });
  it("selects direct URL and preserves Simplify separately", () => {
    const j = parseFeed(feed).jobs[0];
    expect(j.originalApplyUrl).toContain("greenhouse");
    expect(j.simplifyUrl).toContain("simplify.jobs");
    expect(j.locationRaw).toContain("\n");
  });
  it("recognizes lock-only closed rows without fabricated identities", () => {
    const j = parseFeed(feed).jobs[2];
    expect(j.isClosed).toBe(true);
    expect(j.identity).toBeNull();
    expect(eligible(j)).toBe(false);
  });
  it.each([
    ["0d", 0],
    ["7d", 7],
    ["8d", 8],
    ["1mo", 30],
    ["1y", 365],
    ["unknown", null],
  ])("age %s → %s", (input, output) =>
    expect(ageDays(input as string)).toBe(output),
  );
  it("fails closed on changed/empty structures", () =>
    expect(() => parseFeed("Nothing recognizable")).toThrow());
});
describe("URL identities", () => {
  it("removes tracking while retaining job identity", () =>
    expect(
      canonicalize("https://example.com/job?gh_jid=123&utm_source=x&ref=y"),
    ).toBe("https://example.com/job?gh_jid=123"));
  it("equivalent tracked URLs match", () =>
    expect(
      identify("https://boards.greenhouse.io/acme/jobs/123?utm_source=x")
        .fingerprint,
    ).toBe(
      identify("https://job-boards.greenhouse.io/acme/jobs/123?ref=y")
        .fingerprint,
    ));
  it("separates requisitions and tenants", () => {
    expect(
      identify("https://boards.greenhouse.io/acme/jobs/123").fingerprint,
    ).not.toBe(
      identify("https://boards.greenhouse.io/acme/jobs/124").fingerprint,
    );
    expect(identify("https://a.icims.com/jobs/123/job").fingerprint).not.toBe(
      identify("https://b.icims.com/jobs/123/job").fingerprint,
    );
  });
  it("preserves Workday stable identity across locale paths", () =>
    expect(
      identify(
        "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/NY/Engineer_R123",
      ).fingerprint,
    ).toBe(
      identify(
        "https://acme.wd5.myworkdayjobs.com/Careers/job/NY/Engineer_R123/apply",
      ).fingerprint,
    ));
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/plain,a",
    "https://user:pass@example.com",
    "http://example.com",
    "https://127.0.0.1",
  ])("rejects unsafe %s", (u) => expect(() => safeUrl(u)).toThrow());
});
describe("state and dedupe", () => {
  it("first run backfills; repeated runs do not requeue", () => {
    const s = makeStore();
    expect(s.queue()).toHaveLength(2);
    expect(s.ingest(parseFeed(feed).jobs, 7)).toEqual({
      queued: 0,
      newJobs: 0,
      matchingAts: 0,
      excludedByAts: 0,
      alreadyKnown: 2,
      deferred: 0,
      applicationIds: [],
    });
    s.close();
  });
  it("submitted is terminal", () => {
    const s = makeStore(),
      id = s.queue()[0].id;
    s.transition(id, "SUBMITTED");
    expect(() => s.transition(id, "QUEUED")).toThrow();
    expect(canTransition("SUBMITTED", "PROCESSING")).toBe(false);
    s.close();
  });
  it("stale processing and READY become review on restart", () => {
    const s = makeStore(),
      id = s.queue()[0].id;
    s.startAttempt(id);
    s.transition(id, "READY");
    s.recovery();
    expect(s.application(id).status).toBe("NEEDS_REVIEW");
    expect(s.application(id).sessionAvailable).toBe(false);
    s.close();
  });
  it("enforces preparation attempt limits", () => {
    const s = makeStore(),
      id = s.queue()[0].id;
    for (let i = 0; i < 3; i++) {
      s.startAttempt(id);
      s.transition(id, "NEEDS_REVIEW");
    }
    expect(() => s.startAttempt(id)).toThrow("limit");
    s.close();
  });
});
describe("live-run limits", () => {
  const jobs = Array.from({ length: 5 }, (_, index) => {
    const url = `https://example.com/jobs/${index + 1}`;
    return {
      company: `Company ${index + 1}`,
      role: "Engineer",
      category: "Engineering",
      locationRaw: "Remote",
      originalApplyUrl: url,
      simplifyUrl: null,
      ageDays: index,
      isClosed: false,
      observationKey: `observation-${index + 1}`,
      identity: identify(url),
    };
  });
  it.each([
    [undefined, 5, 0],
    [1, 1, 4],
    [3, 3, 2],
    [10, 5, 0],
  ])("limit %s queues %i and defers %i", (limit, queued, deferred) => {
    const store = new Store(":memory:");
    const result = store.ingest(jobs, 7, { limit });
    expect(result.queued).toBe(queued);
    expect(result.deferred).toBe(deferred);
    expect(store.queue()).toHaveLength(queued);
    expect(
      jobs.filter((job) => {
        const stored = store.findIdentity(job.identity.fingerprint)!;
        return store.hasApplication(stored.id);
      }),
    ).toHaveLength(queued);
    store.close();
  });
  it("does not count already-known jobs against the limit", () => {
    const store = new Store(":memory:");
    store.ingest([jobs[0]], 7);
    const result = store.ingest(jobs, 7, { limit: 1 });
    expect(result).toMatchObject({
      queued: 1,
      newJobs: 4,
      alreadyKnown: 1,
      deferred: 3,
    });
    expect(result.applicationIds).toHaveLength(1);
    expect(store.queue()).toHaveLength(2);
    store.close();
  });
  it("rejects invalid CLI and storage limits", () => {
    for (const value of ["0", "-1", "abc", "1.5"])
      expect(() => parseLimit(value)).toThrow("positive integer");
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("10")).toBe(10);
    const store = new Store(":memory:");
    for (const limit of [0, -1, 1.5, Number.NaN])
      expect(() => store.ingest(jobs, 7, { limit })).toThrow(
        "positive integer",
      );
    store.close();
  });
  it("plans a limited dry run without mutating state", () => {
    const known = new Set([jobs[0].identity.fingerprint]);
    const before = [...known];
    const plan = planFeedSelection(jobs, 7, (id) => known.has(id), 3);
    expect(plan).toMatchObject({
      eligibleRows: 5,
      alreadyKnown: 1,
      deferred: 1,
    });
    expect(plan.newJobs).toHaveLength(4);
    expect(plan.selected).toHaveLength(3);
    expect([...known]).toEqual(before);
  });
});
describe("ATS-targeted selection", () => {
  const definitions = [
    [
      "Workday One",
      "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Remote/Engineer_R100",
    ],
    ["Greenhouse One", "https://job-boards.greenhouse.io/acme/jobs/1001"],
    [
      "Ashby One",
      "https://jobs.ashbyhq.com/acme/11111111-1111-4111-8111-111111111111",
    ],
    [
      "Workday Two",
      "https://other.wd5.myworkdayjobs.com/en-US/jobs/job/Remote/Engineer_R200",
    ],
    ["Greenhouse Two", "https://boards.greenhouse.io/other/jobs/2002"],
  ] as const;
  const jobs = definitions.map(([company, url], index) => ({
    company,
    role: "Engineer",
    category: "Engineering",
    locationRaw: "Remote",
    originalApplyUrl: url,
    simplifyUrl: null,
    ageDays: index,
    isClosed: false,
    observationKey: `ats-observation-${index}`,
    identity: identify(url),
  }));

  it.each([
    ["workday", 2],
    ["greenhouse", 2],
    ["ashby", 1],
  ] as const)("selects only %s jobs", (ats, expected) => {
    const plan = planFeedSelection(jobs, 7, () => false, undefined, ats);
    expect(plan.newJobs).toHaveLength(5);
    expect(plan.matchingAts).toHaveLength(expected);
    expect(plan.selected).toHaveLength(expected);
    expect(plan.selected.every((job) => job.identity?.atsType === ats)).toBe(
      true,
    );
  });

  it("omitting ATS preserves the complete new queue", () => {
    const plan = planFeedSelection(jobs, 7, () => false);
    expect(plan.matchingAts).toEqual(plan.newJobs);
    expect(plan.selected).toEqual(plan.newJobs);
    expect(plan.excludedByAts).toBe(0);
  });

  it("applies limit after ATS selection", () => {
    const plan = planFeedSelection(jobs, 7, () => false, 1, "workday");
    expect(plan.newJobs).toHaveLength(5);
    expect(plan.matchingAts).toHaveLength(2);
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0].identity?.atsType).toBe("workday");
    expect(plan.deferred).toBe(1);
    expect(plan.excludedByAts).toBe(3);
  });

  it("removes already-known jobs before ATS filtering", () => {
    const store = new Store(":memory:");
    store.ingest([jobs[0]], 7);
    const result = store.ingest(jobs, 7, { ats: "workday", limit: 1 });
    expect(result).toMatchObject({
      newJobs: 4,
      matchingAts: 1,
      alreadyKnown: 1,
      queued: 1,
      excludedByAts: 3,
    });
    store.close();
  });

  it("creates no application records for ATS-excluded jobs", () => {
    const store = new Store(":memory:");
    const result = store.ingest(jobs, 7, { ats: "workday", limit: 1 });
    expect(result.queued).toBe(1);
    const selectedJobId = store.application(result.applicationIds[0]).jobId;
    for (const job of jobs) {
      const stored = store.findIdentity(job.identity.fingerprint)!;
      expect(store.hasApplication(stored.id)).toBe(stored.id === selectedJobId);
    }
    expect(
      jobs
        .filter((job) => job.identity.atsType !== "workday")
        .every((job) => {
          const stored = store.findIdentity(job.identity.fingerprint)!;
          return !store.hasApplication(stored.id);
        }),
    ).toBe(true);
    store.close();
  });

  it("dry-run ATS planning performs zero database writes", () => {
    const store = new Store(":memory:"),
      before = {
        jobs: store.sqlite.prepare("SELECT count(*) n FROM jobs").get(),
        applications: store.sqlite
          .prepare("SELECT count(*) n FROM applications")
          .get(),
      };
    const plan = planFeedSelection(
      jobs,
      7,
      (fingerprint) => {
        const job = store.findIdentity(fingerprint);
        return !!job && store.hasApplication(job.id);
      },
      1,
      "ashby",
    );
    expect(plan.selected).toHaveLength(1);
    expect({
      jobs: store.sqlite.prepare("SELECT count(*) n FROM jobs").get(),
      applications: store.sqlite
        .prepare("SELECT count(*) n FROM applications")
        .get(),
    }).toEqual(before);
    store.close();
  });

  it("rejects invalid ATS names before selection", () => {
    expect(parseAtsType(undefined)).toBeUndefined();
    for (const ats of [
      "workday",
      "greenhouse",
      "ashby",
      "icims",
      "oracle",
      "generic",
    ])
      expect(parseAtsType(ats)).toBe(ats);
    expect(() => parseAtsType("lever")).toThrow("ATS must be one of");
  });
});
describe("facts and answers", () => {
  it("human corrections win and conflicts do not overwrite", () => {
    const s = makeStore(),
      f = new FactStore(s);
    f.set("experience.pythonYears", 2);
    expect(() => f.set("experience.pythonYears", 3)).toThrow("conflict");
    f.set("experience.pythonYears", 3, {
      correct: true,
      source: "HUMAN_CORRECTED",
    });
    expect(f.get("experience.pythonYears")?.parsed).toBe(3);
    s.close();
  });
  it("company scoped facts never leak to other companies", () => {
    const s = makeStore(),
      f = new FactStore(s);
    f.set("employment.previouslyEmployed", true, { scope: "company:acme" });
    expect(f.get("employment.previouslyEmployed")).toBeNull();
    expect(f.get("employment.previouslyEmployed", "company:other")).toBeNull();
    s.close();
  });
  it("unknown prevents profile resurrection", () => {
    const s = makeStore(),
      f = new FactStore(s);
    f.importProfile(profile);
    const old = f.get("contact.email")!;
    f.unknown(old.id, old.revision);
    f.importProfile(profile);
    expect(f.get("contact.email")).toBeNull();
    s.close();
  });
  it.each([
    "identity.ssn",
    "identity.governmentId",
    "legal.signature",
    "legal.consent",
    "legal.certification",
  ])("never persists %s", (key) => {
    const s = makeStore();
    expect(() => new FactStore(s).set(key, "sensitive")).toThrow();
    s.close();
  });
  it.each([
    ["Email", "contact.email"],
    ["E-mail", "contact.email"],
    ["Preferred Email", "contact.email"],
    ["Contact Email", "contact.email"],
    ["Phone", "contact.phone"],
    ["Mobile", "contact.phone"],
    ["Cell Phone", "contact.phone"],
    ["Telephone", "contact.phone"],
    ["Primary Phone", "contact.phone"],
    ["Current Location", "contact.location"],
    ["Are you willing to relocate?", "preferences.willingToRelocate"],
    ["Are you open to relocation?", "preferences.willingToRelocate"],
    ["How did you learn about this opportunity?", "preferences.jobSource"],
    ["Where did you find this role?", "preferences.jobSource"],
  ])("maps shared semantic alias %s", (question, key) => {
    expect(mapQuestion(question)).toMatchObject({ key });
  });
  it("uses the global LinkedIn preference for source fields and choices", async () => {
    const s = makeStore(),
      f = new FactStore(s);
    f.importProfile(profile);
    const r = new AnswerResolver(f, profile),
      id = s.queue()[0].id,
      context = {
        company: "Acme",
        role: "Engineer",
        description: "",
        facts: {},
      };
    expect(
      await r.resolve(
        {
          label: "How did you hear about this job?",
          type: "text",
          choices: [],
          required: true,
        },
        id,
        context,
      ),
    ).toMatchObject({ answer: "LinkedIn", key: "preferences.jobSource" });
    expect(
      await r.resolve(
        {
          label: "Referral source",
          type: "select",
          choices: ["Company site", "Social Media - LinkedIn", "Other"],
          required: true,
        },
        id,
        context,
      ),
    ).toMatchObject({ answer: "Social Media - LinkedIn" });
    expect(
      await r.resolve(
        {
          label: "Source",
          type: "select",
          choices: ["Company site", "Other"],
          required: true,
        },
        id,
        context,
      ),
    ).toMatchObject({ answer: "Other" });
    s.close();
  });
  it("derives the current application location from configured city and state", () => {
    const s = makeStore(),
      p = structuredClone(profile);
    p.personal.city = "Beaverton";
    p.personal.state = "Oregon";
    const f = new FactStore(s);
    f.importProfile(p);
    expect(f.get("contact.location")?.parsed).toBe("Beaverton, OR");
    s.close();
  });
  it("recognizes equivalent formatted phone values without rewriting the fact", () => {
    expect(
      fieldValueMatches(
        {
          token: 0,
          label: "Primary Phone",
          type: "tel",
          required: true,
          choices: [],
          value: "(555) 010-0000",
          error: "",
          section: "Contact",
          groupIndex: 0,
        },
        "5550100000",
      ),
    ).toBe(true);
  });
  it("leaves optional preferred name unknown and falls back when required", async () => {
    const s = makeStore(),
      p = structuredClone(profile);
    delete p.personal.preferredName;
    const f = new FactStore(s);
    f.importProfile(p);
    const r = new AnswerResolver(f, p),
      id = s.queue()[0].id,
      context = {
        company: "Acme",
        role: "Engineer",
        description: "",
        facts: {},
      };
    expect(
      await r.resolve(
        {
          label: "Preferred First Name",
          type: "text",
          choices: [],
          required: false,
        },
        id,
        context,
      ),
    ).toHaveProperty("reason");
    expect(
      await r.resolve(
        {
          label: "Preferred First Name",
          type: "text",
          choices: [],
          required: true,
        },
        id,
        context,
      ),
    ).toMatchObject({ answer: p.personal.firstName });
    s.close();
  });
  it("maps citizenship facts to boolean or country field", async () => {
    const s = makeStore(),
      f = new FactStore(s);
    f.set("identity.citizenship", "United States");
    const r = new AnswerResolver(f, profile),
      id = s.queue()[0].id,
      c = { company: "Acme", role: "Engineer", description: "", facts: {} };
    const result = await r.resolve(
      {
        label: "Are you a United States citizen?",
        type: "select",
        choices: ["Yes", "No"],
        required: true,
      },
      id,
      c,
    );
    expect(result).toMatchObject({ answer: "Yes" });
    expect(
      await r.resolve(
        {
          label: "Country of citizenship",
          type: "text",
          choices: [],
          required: true,
        },
        id,
        c,
      ),
    ).toMatchObject({ answer: "United States" });
    s.close();
  });
  it("does not guess unknown legal facts or salary", async () => {
    const s = makeStore(),
      f = new FactStore(s),
      generate = vi.fn(),
      r = new AnswerResolver(f, profile, generate),
      id = s.queue()[0].id;
    for (const label of [
      "Desired salary",
      "Have you ever been convicted?",
      "Do you have active Secret clearance?",
    ])
      expect(
        await r.resolve(
          { label, type: "text", choices: [], required: true },
          id,
          { company: "Acme", role: "Engineer", description: "", facts: {} },
        ),
      ).toHaveProperty("reason");
    expect(generate).not.toHaveBeenCalled();
    s.close();
  });
  it("preserves sponsorship qualifiers and ambiguity", () => {
    expect(
      mapQuestion("Will you now or in the future require sponsorship?")
        ?.transform,
    ).toBe("sponsorshipCombined");
    expect(mapQuestion("Do you require sponsorship?")).toBeNull();
    expect(
      mapQuestion("Are you authorized to work without sponsorship?"),
    ).toBeNull();
  });
  it("does not guess semantically ambiguous choices", () =>
    expect(
      mapValue("Asian", {
        label: "Race",
        type: "select",
        choices: ["Asian - East", "Asian - South"],
        required: true,
      }),
    ).toBeNull());
  it.each([
    ["Do you identify as transgender?", "demographics.transgender"],
    ["Are you transgender?", "demographics.transgender"],
    ["Transgender status", "demographics.transgender"],
    ["Gender identity: transgender", "demographics.transgender"],
    ["Sexual orientation", "demographics.sexualOrientation"],
    [
      "Which sexual orientation best describes you?",
      "demographics.sexualOrientation",
    ],
    ["Sexual identity", "demographics.sexualOrientation"],
  ])("maps demographic alias %s independently", (question, key) => {
    expect(mapQuestion(question)).toMatchObject({ key, scope: "global" });
  });
  it("selects the configured race at the most specific offered level", () => {
    expect(
      mapValue(["Asian", "South Asian"], {
        label: "Race",
        type: "select",
        choices: ["Asian", "White", "Black"],
        required: false,
      }),
    ).toBe("Asian");
    expect(
      mapValue(["Asian", "South Asian"], {
        label: "Racial/ethnic background",
        type: "checkbox",
        choices: ["South Asian", "East Asian", "Southeast Asian"],
        required: false,
      }),
    ).toBe("South Asian");
    expect(
      mapValue(["Asian", "South Asian"], {
        label: "Racial/ethnic background",
        type: "checkbox",
        choices: ["Asian", "South Asian", "East Asian", "Southeast Asian"],
        required: false,
      }),
    ).toBe("South Asian");
  });
  it("maps confirmed transgender and sexual-orientation facts conservatively", () => {
    expect(
      mapValue(false, {
        label: "Do you identify as transgender?",
        type: "radio",
        choices: ["Yes", "No", "Prefer not to answer"],
        required: false,
      }),
    ).toBe("No");
    expect(
      mapValue("Heterosexual", {
        label: "Sexual orientation",
        type: "radio",
        choices: ["Straight", "Gay", "Bisexual"],
        required: false,
      }),
    ).toBe("Straight");
    expect(
      mapValue("Heterosexual", {
        label: "Sexual orientation",
        type: "radio",
        choices: ["Heterosexual / Straight", "Gay", "Bisexual"],
        required: false,
      }),
    ).toBe("Heterosexual / Straight");
  });
  it("maps Ashby-specific factual choices conservatively", () => {
    expect(
      mapValue("Male", {
        label: "How would you describe your gender identity?",
        type: "checkbox",
        choices: ["Man", "Woman", "Non-binary"],
        required: false,
      }),
    ).toBe("Man");
    expect(
      mapValue("Bachelor of Science", {
        label: "Which degree are you currently pursuing?",
        type: "radio",
        choices: ["Bachelors", "Masters", "PhD"],
        required: true,
      }),
    ).toBe("Bachelors");
    expect(
      mapValue("2026-05", {
        label: "When is your expected graduation date?",
        type: "radio",
        choices: ["2025", "2026", "January - June 2027"],
        required: true,
      }),
    ).toBe("2026");
    expect(
      mapValue("Not a veteran", {
        label: "Are you a veteran or active member of the Armed Forces?",
        type: "radio",
        choices: ["Yes, I am a veteran", "No, I am not a veteran"],
        required: false,
      }),
    ).toBe("No, I am not a veteran");
    expect(
      mapValue("Asian", {
        label: "How would you describe your racial/ethnic background?",
        type: "checkbox",
        choices: ["South Asian", "East Asian", "Southeast Asian"],
        required: false,
      }),
    ).toBeNull();
  });
  it("human attestation is always reserved", () =>
    expect(humanOnly("I certify all information is true")).toBe(true));
});
describe("hard submit guard", () => {
  it.each([
    "Submit",
    "Submit Application",
    "Send Application",
    "Complete Application",
    "Finish and Submit",
  ])("blocks %s", (name) =>
    expect(() => authorizeAction("QUESTIONS", "NEXT", name)).toThrow(),
  );
  it("blocks final endpoints even with a Next label", () =>
    expect(() =>
      authorizeAction("QUESTIONS", "NEXT", "Next", {
        formAction: "/application/submit",
      }),
    ).toThrow());
  it("blocks native application form Next submission", () =>
    expect(() =>
      authorizeAction("QUESTIONS", "NEXT", "Next", { nativeSubmit: true }),
    ).toThrow());
  it("permits verified account-only submission", () =>
    expect(() =>
      authorizeAction("ACCOUNT_CREATE", "ACCOUNT_CREATE", "Create Account", {
        nativeSubmit: true,
      }),
    ).not.toThrow());
  it("rejects account context overlapping application upload", () =>
    expect(() =>
      authorizeAction("ACCOUNT_CREATE", "ACCOUNT_CREATE", "Create Account", {
        hasApplicationFields: true,
      }),
    ).toThrow());
  it("permits Next and initial Apply", () => {
    expect(() => authorizeAction("CONTACT", "NEXT", "Next")).not.toThrow();
    expect(() => authorizeAction("LANDING", "BEGIN", "Apply")).not.toThrow();
  });
  it("review stage cannot advance", () =>
    expect(() => authorizeAction("REVIEW", "NEXT", "Next")).toThrow());
  it("recognizes final complete wording", () =>
    expect(isFinalAction("Complete Application")).toBe(true));
});
describe("privacy, host safety and optional integrations", () => {
  it("redacts secrets and verification URL tokens", () =>
    expect(
      redact({
        password: "secret",
        nested: { cookie: "value" },
        url: "https://example.com/verify?token=abc",
      }),
    ).toEqual({
      password: "[REDACTED]",
      nested: { cookie: "[REDACTED]" },
      url: "https://example.com/verify?token=[REDACTED]",
    }));
  it("429 and security challenges open host circuit", () => {
    const h = new HostSafety();
    h.response("a", 429);
    expect(() => h.check("a")).toThrow();
    h.challenge("b");
    expect(() => h.check("b")).toThrow();
    h.check("c");
  });
  it("exactly one approved verification link is accepted", () => {
    const t = {
      tenant: "a",
      email: "a@example.com",
      company: "Acme",
      ats: "workday",
      triggeredAt: Date.now(),
      trustedOrigins: ["https://acme.myworkdayjobs.com"],
      expectedSenders: ["myworkday.com"],
    };
    expect(
      chooseVerification(
        "Verify: https://acme.myworkdayjobs.com/verify?token=x",
        t,
      )?.link,
    ).toContain("/verify");
    expect(
      chooseVerification(
        "Password reset https://acme.myworkdayjobs.com/verify?token=x",
        t,
      ),
    ).toBeNull();
    expect(
      chooseVerification("https://unknown.com/verify?token=x", t),
    ).toBeNull();
  });
  it("rejects unsupported generated numerical claims", () => {
    const c = {
      company: "Acme",
      role: "Engineer",
      description: "",
      facts: { experience: "2 years Python" },
    };
    expect(validateGenerated("I have 5 years Python experience.", c)).toBe(
      false,
    );
    expect(validateGenerated("I have 2 years Python experience.", c)).toBe(
      true,
    );
  });
  it("provider receives mocked secrets without logging them", async () => {
    const get = vi.fn().mockRejectedValue(new Error("missing"));
    const p = new CompatibleProvider(
      {
        baseUrl: "https://example.com/v1",
        model: "configured",
        enabled: true,
        structuredOutput: false,
      },
      { get, set: vi.fn() },
    );
    expect(
      await p.generate(
        {
          label: "Why this role?",
          type: "textarea",
          choices: [],
          required: true,
        },
        { company: "Acme", role: "Engineer", description: "", facts: {} },
      ),
    ).toBeNull();
    expect(get).toHaveBeenCalledWith("llm-api-key");
  });
});
