import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { profileSchema } from "../../src/config/profile.js";
import { parseFeed, ageDays, eligible } from "../../src/feed/parser.js";
import { canonicalize, identify } from "../../src/feed/identity.js";
import { Store, canTransition } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
import {
  AnswerResolver,
  mapQuestion,
  mapValue,
  humanOnly,
} from "../../src/answers/resolver.js";
import { authorizeAction, isFinalAction } from "../../src/browser/actions.js";
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
      alreadyKnown: 2,
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
