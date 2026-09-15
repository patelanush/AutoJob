import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { profileSchema, type Profile } from "../../src/config/profile.js";
import { Store } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
import { AnswerResolver } from "../../src/answers/resolver.js";
import { BrowserActions } from "../../src/browser/actions.js";
import { adapters } from "../../src/ats/index.js";
import { identify } from "../../src/feed/identity.js";
function context(profile?: Profile) {
  const p =
      profile ??
      profileSchema.parse(
        JSON.parse(readFileSync("profile.example.json", "utf8")),
      ),
    store = new Store(":memory:"),
    identity = identify(
      "https://tenant.myworkdayjobs.com/Careers/job/NY/Engineer_R123",
    );
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
        observationKey: "fixture",
        identity,
      },
    ],
    7,
  );
  const id = store.queue()[0].id;
  store.startAttempt(id);
  const f = new FactStore(store);
  f.importProfile(p);
  return {
    profile: p,
    store,
    appId: id,
    resolver: new AnswerResolver(f, p),
    generation: {
      company: "Fixture",
      role: "Engineer",
      description: "",
      facts: {},
    },
    password: async () => "fixture-only-password",
  };
}
test("early MFA is human-unlockable NEEDS REVIEW", async ({ page }) => {
  await page.setContent(
    "<h1>SMS verification</h1><p>Enter the code from your authenticator</p>",
  );
  const c = context();
  const r = await adapters[1].prepare({
    ...c,
    browser: new BrowserActions(page, true),
  });
  expect(r.status).toBe("NEEDS_REVIEW");
  expect(r.reason).toContain("MFA");
  c.store.close();
});
test("early blocking security challenge is SKIPPED", async ({ page }) => {
  await page.setContent("<h1>Verify you are human</h1>");
  const c = context();
  const r = await adapters[1].prepare({
    ...c,
    browser: new BrowserActions(page, true),
  });
  expect(r.status).toBe("SKIPPED");
  c.store.close();
});
test("ambiguous failed login never triggers registration", async ({ page }) => {
  await page.setContent(
    '<form id="login"><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Sign In</button></form><button type="button" id="create">Create Account</button><p id="error"></p><script>window.registrations=0;document.getElementById("login").onsubmit=e=>{e.preventDefault();document.getElementById("error").textContent="Invalid email or password"};document.getElementById("create").onclick=()=>window.registrations++</script>',
  );
  const c = context();
  const r = await adapters[1].prepare({
    ...c,
    browser: new BrowserActions(page, true),
  });
  expect(r.status).toBe("NEEDS_REVIEW");
  expect(r.reason).toContain("ambiguous");
  expect(
    await page.evaluate(
      () => (window as unknown as { registrations: number }).registrations,
    ),
  ).toBe(0);
  c.store.close();
});
test("explicit absent account permits normal registration", async ({
  page,
}) => {
  await page.setContent(
    `<form id="auth"><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Sign In</button></form><p id="message"></p><button type="button" id="create">Create Account</button><script>window.accountCreates=0;document.getElementById('auth').onsubmit=e=>{e.preventDefault();document.getElementById('message').textContent='No account found'};document.getElementById('create').onclick=()=>{document.body.innerHTML='<form id="register"><label>Email<input type="email"></label><label>Password<input type="password"></label><label>Confirm password<input type="password"></label><button>Create Account</button></form>';document.getElementById('register').onsubmit=e=>{e.preventDefault();window.accountCreates++;document.body.innerHTML='<label>First name<input required></label><button>Submit Application</button>'}}</script>`,
  );
  const c = context();
  const r = await adapters[1].prepare({
    ...c,
    browser: new BrowserActions(page, true),
  });
  expect(r.status).toBe("READY");
  expect(
    await page.evaluate(
      () => (window as unknown as { accountCreates: number }).accountCreates,
    ),
  ).toBe(1);
  c.store.close();
});
test("two independent radio groups resolve correct Yes/No and demographic options", async ({
  page,
}) => {
  await page.setContent(
    '<form><fieldset><legend>Are you legally authorized to work in the United States?</legend><label>Yes<input name="work" type="radio" required></label><label>No<input name="work" type="radio"></label></fieldset><fieldset><legend>Gender</legend><label>Male<input name="gender" type="radio" required></label><label>Female<input name="gender" type="radio"></label></fieldset><button>Submit Application</button></form>',
  );
  const c = context();
  c.resolver.factStore.set("identity.workAuthorizationUS", false);
  c.resolver.factStore.set("demographics.gender", "Male");
  const r = await adapters[0].prepare({
    ...c,
    browser: new BrowserActions(page, true),
  });
  expect(r.status).toBe("READY");
  await expect(page.getByLabel("No", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Male", { exact: true })).toBeChecked();
  c.store.close();
});
test("repeated employment fields use separate configured records", async ({
  page,
}) => {
  await page.setContent(
    '<section><h2>Experience</h2><div data-record><label>Employer<input required></label><label>Job title<input required></label></div><div data-record><label>Employer<input required></label><label>Job title<input required></label></div></section><button type="submit">Submit Application</button>',
  );
  const p = profileSchema.parse(
    JSON.parse(readFileSync("profile.example.json", "utf8")),
  );
  p.employment = [
    { employer: "First Company", title: "Intern", startDate: "2023-06-01" },
    { employer: "Second Company", title: "Engineer", startDate: "2024-06-01" },
  ];
  const c = context(p),
    r = await adapters[1].prepare({
      ...c,
      browser: new BrowserActions(page, true),
    });
  expect(r.status).toBe("READY");
  expect(
    await page.getByLabel("Employer", { exact: true }).nth(0).inputValue(),
  ).toBe("First Company");
  expect(
    await page.getByLabel("Employer", { exact: true }).nth(1).inputValue(),
  ).toBe("Second Company");
  c.store.close();
});
test("Gmail verification navigation blocks untrusted redirect before arrival", async ({
  page,
}) => {
  await page.route("https://trusted.example/verify", (route) =>
    route.fulfill({
      status: 302,
      headers: { location: "https://untrusted.example/collect" },
    }),
  );
  const b = new BrowserActions(page);
  await b.installGuard();
  await expect(
    b.navigateVerification("https://trusted.example/verify", [
      "https://trusted.example",
    ]),
  ).rejects.toThrow();
  expect(page.url()).not.toContain("untrusted.example");
});
test("keychain/password pages are excluded from screenshots", async ({
  page,
}) => {
  await page.setContent(
    '<label>Password<input type="password" value="fixture-password"></label>',
  );
  const b = new BrowserActions(page, true);
  await b.screenshot("data/should-not-exist.png");
  const { existsSync } = await import("node:fs");
  expect(existsSync("data/should-not-exist.png")).toBe(false);
});
