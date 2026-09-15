import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileSchema } from "../../src/config/profile.js";
import { Store } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
import { AnswerResolver } from "../../src/answers/resolver.js";
import { BrowserActions } from "../../src/browser/actions.js";
import { adapters } from "../../src/ats/index.js";
import { atsFixture, hydratedAshbyFixture } from "../fixtures/ats.js";
import { identify } from "../../src/feed/identity.js";
for (const type of [
  "greenhouse",
  "workday",
  "ashby",
  "icims",
  "oracle",
  "generic",
])
  test(`${type}: prepares and never submits`, async ({ page }) => {
    const server = createServer((_, res) =>
      res.end(atsFixture(type, type === "workday" || type === "oracle")),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Fixture port");
    const temp = mkdtempSync(join(tmpdir(), "job-agent-")),
      resume = join(temp, "resume.txt");
    writeFileSync(resume, "Authorized fixture resume");
    const profile = profileSchema.parse(
      JSON.parse(readFileSync("profile.example.json", "utf8")),
    );
    profile.resume.path = resume;
    profile.authorization.authorizedToWorkUS = true;
    const store = new Store(":memory:"),
      identity = identify(`https://example.com/${type}/jobs/1`);
    store.ingest(
      [
        {
          company: "Fixture",
          role: "Engineer",
          category: "Test",
          locationRaw: "AZ",
          originalApplyUrl: identity.canonicalUrl,
          simplifyUrl: null,
          ageDays: 0,
          isClosed: false,
          observationKey: type,
          identity,
        },
      ],
      7,
    );
    const id = store.queue()[0].id;
    store.startAttempt(id);
    const facts = new FactStore(store);
    facts.importProfile(profile);
    const browser = new BrowserActions(page, true);
    await browser.installGuard();
    await browser.navigate(`http://127.0.0.1:${addr.port}`);
    const result = await adapters
      .find((a) => a.type === type)!
      .prepare({
        browser,
        resolver: new AnswerResolver(facts, profile),
        profile,
        store,
        appId: id,
        generation: {
          company: "Fixture",
          role: "Engineer",
          description: "",
          facts: {},
        },
        password: async () => {
          throw new Error("Not needed");
        },
      });
    expect(result.status).toBe("READY");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { finalSubmissions: number }).finalSubmissions,
      ),
    ).toBe(0);
    expect(
      await page
        .getByRole("button", { name: "Submit Application" })
        .isVisible(),
    ).toBe(true);
    store.close();
    server.close();
    rmSync(temp, { recursive: true });
  });
test("misleading native Next form cannot submit", async ({ page }) => {
  await page.setContent(
    '<form action="/application/submit"><button>Next</button></form>',
  );
  const b = new BrowserActions(page, true);
  b.stage = "QUESTIONS";
  await expect(b.advance("NEXT", /^Next$/)).rejects.toThrow("blocked");
});
test("account-only creation can submit without job submission", async ({
  page,
}) => {
  await page.setContent(
    '<form id="account"><button>Create Account</button></form><script>window.accountCount=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.accountCount++}</script>',
  );
  const b = new BrowserActions(page, true);
  b.stage = "ACCOUNT_CREATE";
  await b.advance("ACCOUNT_CREATE", /^Create Account$/);
  expect(
    await page.evaluate(
      () => (window as unknown as { accountCount: number }).accountCount,
    ),
  ).toBe(1);
});
test("human takeover blocks worker mutation", async ({ page }) => {
  await page.setContent("<label>Email<input></label>");
  const b = new BrowserActions(page, true),
    f = await b.inspect();
  b.takeOver();
  await expect(b.fill(f[0].token, "a@example.com")).rejects.toThrow(
    "Human owns",
  );
});
test("unknown salary remains NEEDS REVIEW without guessing", async ({
  page,
}) => {
  await page.setContent(
    "<form><label>Desired salary<input required></label><button>Submit Application</button></form>",
  );
  const store = new Store(":memory:"),
    identity = identify("https://example.com/jobs/2");
  store.ingest(
    [
      {
        company: "Fixture",
        role: "Engineer",
        category: "Test",
        locationRaw: "",
        originalApplyUrl: identity.canonicalUrl,
        simplifyUrl: null,
        ageDays: 0,
        isClosed: false,
        observationKey: "salary",
        identity,
      },
    ],
    7,
  );
  const id = store.queue()[0].id,
    profile = profileSchema.parse(
      JSON.parse(readFileSync("profile.example.json", "utf8")),
    ),
    facts = new FactStore(store),
    b = new BrowserActions(page, true);
  const result = await adapters[0].prepare({
    browser: b,
    resolver: new AnswerResolver(facts, profile),
    profile,
    store,
    appId: id,
    generation: {
      company: "Fixture",
      role: "Engineer",
      description: "",
      facts: {},
    },
    password: async () => "",
  });
  expect(result.status).toBe("NEEDS_REVIEW");
  expect(result.reason).toContain("salary");
  expect(await page.getByLabel("Desired salary").inputValue()).toBe("");
  store.close();
});

async function prepareHydratedAshby(
  page: import("playwright").Page,
  requiredUnknown: boolean,
  clearKnownEmailOnce = false,
  knownDemographics = true,
) {
  const server = createServer((_, res) =>
    res.end(hydratedAshbyFixture(requiredUnknown, clearKnownEmailOnce)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port");
  const temp = mkdtempSync(join(tmpdir(), "job-agent-ashby-")),
    resume = join(temp, "resume.txt");
  writeFileSync(resume, "Authorized fixture resume");
  const profile = profileSchema.parse(
    JSON.parse(readFileSync("profile.example.json", "utf8")),
  );
  Object.assign(profile.personal, {
    firstName: "Anush",
    lastName: "Patel",
    city: "Beaverton",
    state: "Oregon",
    country: "United States",
  });
  profile.resume.path = resume;
  profile.links.linkedin = "https://www.linkedin.com/in/anush-patel";
  profile.authorization.authorizedToWorkUS = true;
  profile.authorization.sponsorshipRequiredNow = false;
  profile.preferences.willingToRelocate = true;
  profile.education = [
    {
      school: "Fixture University",
      degree: "Bachelor of Science",
      major: "Computer Science",
      graduationDate: "2026-05",
    },
  ];
  profile.demographics = {
    gender: "Male",
    race: knownDemographics ? ["Asian", "South Asian"] : "Asian",
    veteranStatus: "Not a veteran",
    disabilityStatus: "No disability",
    ...(knownDemographics
      ? { transgender: false, sexualOrientation: "Heterosexual" }
      : {}),
  };
  const store = new Store(":memory:"),
    identity = identify("https://jobs.ashbyhq.com/fixture/job-id");
  store.ingest(
    [
      {
        company: "Fixture",
        role: "Engineer",
        category: "Test",
        locationRaw: "",
        originalApplyUrl: identity.canonicalUrl,
        simplifyUrl: null,
        ageDays: 0,
        isClosed: false,
        observationKey: "hydrated-ashby",
        identity,
      },
    ],
    7,
  );
  const id = store.queue()[0].id,
    job = store.job(store.application(id).jobId),
    facts = new FactStore(store);
  facts.importProfile(profile);
  facts.set("education.attendingOrRecentlyGraduatedUSCanada", true);
  facts.set("education.csOrRelatedDegree", true);
  facts.set("preferences.withinHub50Miles", false, {
    scope: `job:${job.id}`,
  });
  const browser = new BrowserActions(page, true);
  await browser.navigate(
    `http://127.0.0.1:${address.port}/application?embed=true`,
  );
  const result = await adapters
    .find((adapter) => adapter.type === "ashby")!
    .prepare({
      browser,
      resolver: new AnswerResolver(facts, profile),
      profile,
      store,
      appId: id,
      generation: {
        company: "Fixture",
        role: "Engineer",
        description: "",
        facts: {},
      },
      password: async () => "",
    });
  return {
    result,
    store,
    server,
    temp,
  };
}

test("live-shaped Ashby form hydrates and fills semantic controls", async ({
  page,
}) => {
  const fixture = await prepareHydratedAshby(page, false);
  expect(fixture.result.status, JSON.stringify(fixture.result)).toBe("READY");
  expect(await page.getByLabel("Legal Full Name *").inputValue()).toBe(
    "Anush Patel",
  );
  expect(await page.getByLabel("Preferred First Name").inputValue()).toBe("");
  expect(await page.getByLabel("Email").inputValue()).toBe(
    "applicant@example.com",
  );
  expect(await page.getByLabel("Phone").inputValue()).toBe("5550100000");
  expect(
    await page.getByLabel("How did you hear about this job?").inputValue(),
  ).toBe("LinkedIn Job Posting");
  expect(
    await page
      .locator('[data-field-path="location"] input[role="combobox"]')
      .inputValue(),
  ).toBe("Beaverton, Oregon, United States");
  expect(await page.getByLabel("LinkedIn URL").inputValue()).toContain(
    "linkedin.com",
  );
  expect(
    await page
      .getByRole("button", { name: "Yes" })
      .nth(0)
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    await page
      .locator('[data-field-path="sponsorship"]')
      .getByRole("button", { name: "No" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(await page.getByLabel("Bachelors").isChecked()).toBe(true);
  expect(await page.getByLabel("2026").isChecked()).toBe(true);
  expect(
    await page
      .locator('[data-field-path="relocation"]')
      .getByRole("button", { name: "Yes" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(await page.getByLabel("Man", { exact: true }).isChecked()).toBe(true);
  expect(
    await page.getByLabel("South Asian", { exact: true }).isChecked(),
  ).toBe(true);
  expect(await page.getByLabel("East Asian", { exact: true }).isChecked()).toBe(
    false,
  );
  expect(
    await page.getByLabel("Southeast Asian", { exact: true }).isChecked(),
  ).toBe(false);
  expect(
    await page
      .getByRole("group")
      .filter({ hasText: "Do you identify as transgender?" })
      .getByLabel("No", { exact: true })
      .isChecked(),
  ).toBe(true);
  expect(
    await page.getByLabel("Heterosexual", { exact: true }).isChecked(),
  ).toBe(true);
  expect(
    await page.getByLabel("Optional demographic detail").inputValue(),
  ).toBe("");
  expect(
    await page
      .getByLabel("Resume")
      .evaluate((input) => (input as HTMLInputElement).files?.item(0)?.name),
  ).toBe("resume.txt");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { finalSubmissions: number }).finalSubmissions,
    ),
  ).toBe(0);
  fixture.store.close();
  fixture.server.close();
  rmSync(fixture.temp, { recursive: true });
});

test("required Ashby unknown is review while optional unknown is allowed", async ({
  page,
}) => {
  const fixture = await prepareHydratedAshby(page, true, false, false);
  expect(fixture.result.status).toBe("NEEDS_REVIEW");
  expect(fixture.result.reason).toContain("racial/ethnic background");
  expect(
    await page.getByLabel("Optional demographic detail").inputValue(),
  ).toBe("");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { finalSubmissions: number }).finalSubmissions,
    ),
  ).toBe(0);
  fixture.store.close();
  fixture.server.close();
  rmSync(fixture.temp, { recursive: true });
});

test("unknown optional demographic facts stay blank without blocking readiness", async ({
  page,
}) => {
  const fixture = await prepareHydratedAshby(page, false, false, false);
  expect(fixture.result.status).toBe("READY");
  for (const label of [
    "South Asian",
    "East Asian",
    "Southeast Asian",
    "Heterosexual",
  ])
    expect(await page.getByLabel(label, { exact: true }).isChecked()).toBe(
      false,
    );
  const transgender = page
    .getByRole("group")
    .filter({ hasText: "Do you identify as transgender?" });
  expect(await transgender.getByLabel("Yes", { exact: true }).isChecked()).toBe(
    false,
  );
  expect(await transgender.getByLabel("No", { exact: true }).isChecked()).toBe(
    false,
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { finalSubmissions: number }).finalSubmissions,
    ),
  ).toBe(0);
  fixture.store.close();
  fixture.server.close();
  rmSync(fixture.temp, { recursive: true });
});

test("known required Ashby value is reconciled when the first fill is lost", async ({
  page,
}) => {
  const fixture = await prepareHydratedAshby(page, false, true);
  expect(fixture.result.status, JSON.stringify(fixture.result)).toBe("READY");
  expect(await page.getByLabel("Email").inputValue()).toBe(
    "applicant@example.com",
  );
  expect(
    fixture.store
      .details(fixture.store.list()[0].application.id)
      .events.some((event) => event.eventType === "RECONCILED"),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { finalSubmissions: number }).finalSubmissions,
    ),
  ).toBe(0);
  fixture.store.close();
  fixture.server.close();
  rmSync(fixture.temp, { recursive: true });
});

test("a correct existing value is not cleared or refilled", async ({
  page,
}) => {
  await page.setContent(
    '<label>Email<input type="email" required value="applicant@example.com"></label><script>window.inputEvents=0;document.querySelector("input").addEventListener("input",()=>window.inputEvents++)</script>',
  );
  const browser = new BrowserActions(page, true),
    [email] = await browser.inspect();
  expect(await browser.fill(email.token, "applicant@example.com")).toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as { inputEvents: number }).inputEvents,
    ),
  ).toBe(0);
});

test("unsupported-form diagnostics are bounded and scrub field values", async ({
  page,
}) => {
  await page.setContent(
    '<main><input value="private value"><button>Unrecognized</button></main>',
  );
  const browser = new BrowserActions(page, true),
    diagnostics = await browser.formDiagnostics();
  expect(diagnostics.counts.inputs).toBe(1);
  expect(diagnostics.counts.buttons).toBe(1);
  expect(diagnostics.accessibleNames.length).toBeLessThanOrEqual(30);
  expect(diagnostics.sanitizedForms.join(" ")).not.toContain("private value");
});
