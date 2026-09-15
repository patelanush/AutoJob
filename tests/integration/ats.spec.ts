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
import { atsFixture } from "../fixtures/ats.js";
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
