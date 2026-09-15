import type { Page, Locator, Frame } from "playwright";
import { safeUrl } from "../security/privacy.js";
export type Stage =
  | "LANDING"
  | "AUTH"
  | "ACCOUNT_CREATE"
  | "EMAIL_VERIFY"
  | "RESUME"
  | "CONTACT"
  | "EXPERIENCE"
  | "EDUCATION"
  | "QUESTIONS"
  | "DISCLOSURES"
  | "REVIEW";
export type Purpose =
  | "BEGIN"
  | "LOGIN"
  | "ACCOUNT_CREATE"
  | "VERIFY_ACCOUNT"
  | "NEXT"
  | "REVIEW"
  | "SAVE_DRAFT"
  | "ADD_RECORD";
export class SafetyStop extends Error {
  constructor(
    message: string,
    readonly reason = "SAFETY",
  ) {
    super(message);
  }
}
export function isFinalAction(name: string) {
  return /submit|send application|complete application|finish(?: and)? (?:apply|application)|finish and|apply now.*submit/i.test(
    name,
  );
}
export function authorizeAction(
  stage: Stage,
  purpose: Purpose,
  name: string,
  details: {
    formAction?: string;
    nativeSubmit?: boolean;
    hasApplicationFields?: boolean;
  } = {},
) {
  const account =
    (purpose === "ACCOUNT_CREATE" && stage === "ACCOUNT_CREATE") ||
    (purpose === "LOGIN" && stage === "AUTH") ||
    (purpose === "VERIFY_ACCOUNT" && stage === "EMAIL_VERIFY");
  if (stage === "REVIEW")
    throw new SafetyStop("Review is a terminal automation stage");
  if (account) {
    if (
      details.hasApplicationFields ||
      (isFinalAction(name) && !/^submit$/i.test(name.trim()))
    )
      throw new SafetyStop("Account form overlaps application submission");
    return;
  }
  if (
    isFinalAction(name) ||
    /submit|applications?\/complete/i.test(details.formAction ?? "")
  )
    throw new SafetyStop("Final application submission blocked");
  if (details.nativeSubmit)
    throw new SafetyStop(
      "Native form submission requires verified account-only context",
    );
  if (purpose === "BEGIN" && stage !== "LANDING")
    throw new SafetyStop("Apply only allowed at verified landing stage");
  if (
    !{
      BEGIN:
        /^(?:apply|apply now|apply for this job|start application|apply manually)$/i,
      LOGIN: /sign in|log in/i,
      ACCOUNT_CREATE: /create account|register|sign up/i,
      VERIFY_ACCOUNT: /^(?:verify|verify email|confirm email)$/i,
      NEXT: /^(?:next|continue|save and continue)$/i,
      REVIEW: /^(?:review|review application)$/i,
      SAVE_DRAFT: /^save(?: draft)?$/i,
      ADD_RECORD:
        /^add(?: another)?(?: work| employment| experience| education| school| record)?$/i,
    }[purpose].test(name.trim())
  )
    throw new SafetyStop("Ambiguous navigation control");
}
export interface Field {
  token: number;
  label: string;
  type: string;
  required: boolean;
  choices: string[];
  value: string;
  error: string;
  section: string;
  maxLength?: number;
  groupIndex: number;
  groupLabel?: string;
  optionLabel?: string;
  groupName?: string;
}
interface BoundField {
  field: Field;
  locator: Locator;
  frame: Frame;
}
export class BrowserActions {
  stage: Stage = "LANDING";
  ownership: "AUTOMATION" | "HUMAN" = "AUTOMATION";
  beforeMutation?: () => Promise<void>;
  private fields: BoundField[] = [];
  private finalRequestPatterns: RegExp[] = [];
  private guardInstalled = false;
  constructor(
    private readonly page: Page,
    readonly fixture = false,
  ) {
    page.setDefaultTimeout(5000);
  }
  private own() {
    if (this.ownership !== "AUTOMATION")
      throw new SafetyStop("Human owns this page", "TAKEOVER");
    if (this.page.isClosed())
      throw new SafetyStop("Application tab was closed", "SESSION_LOST");
  }
  private async checkpoint() {
    this.own();
    await this.beforeMutation?.();
    this.own();
  }
  async installGuard(patterns: RegExp[] = []) {
    this.finalRequestPatterns = patterns;
    if (this.guardInstalled) return;
    this.guardInstalled = true;
    await this.page.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        try {
          safeUrl(request.url(), this.fixture);
        } catch {
          await route.abort("blockedbyclient");
          return;
        }
      }
      if (
        this.ownership === "AUTOMATION" &&
        this.finalRequestPatterns.some((p) => p.test(request.url())) &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method())
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    this.page.on("download", (d) => void d.cancel());
    this.page.on("dialog", (d) => void d.dismiss());
  }
  async navigate(url: string) {
    this.own();
    await this.page.goto(safeUrl(url, this.fixture), {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
  }
  url() {
    return this.page.url();
  }
  identityLocations() {
    return [
      ...new Set([this.url(), ...this.page.frames().map((f) => f.url())]),
    ].filter((u) => u.startsWith("https:"));
  }
  async text() {
    const texts = [];
    for (const frame of this.page.frames()) {
      if (/recaptcha|hcaptcha/i.test(frame.url())) continue;
      texts.push(
        await frame
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
    }
    return texts.join("\n").slice(0, 100000);
  }
  async signature() {
    return {
      url: this.url(),
      text: (await this.text()).slice(0, 12000),
      html: (await this.page.locator("body").innerHTML()).slice(0, 15000),
    };
  }
  async controls() {
    return this.page.getByRole("button").allTextContents();
  }
  async securityChallenge() {
    for (const frame of await this.page
      .locator(
        "iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[title*=challenge]",
      )
      .all()) {
      const src = (await frame.getAttribute("src")) ?? "";
      if (!/size=invisible/.test(src) && (await frame.isVisible())) return true;
    }
    return false;
  }
  async hasControl(name: RegExp) {
    for (const frame of this.page.frames()) {
      const candidates = frame
        .getByRole("button", { name })
        .or(frame.getByRole("link", { name }));
      for (const c of await candidates.all())
        if (await c.isVisible()) return true;
    }
    return false;
  }
  async advance(purpose: Purpose, name: RegExp) {
    await this.checkpoint();
    const visible: Locator[] = [];
    for (const frame of this.page.frames()) {
      const loc = frame
        .getByRole("button", { name })
        .or(frame.getByRole("link", { name }));
      for (const l of await loc.all()) if (await l.isVisible()) visible.push(l);
    }
    if (visible.length !== 1)
      throw new SafetyStop("Navigation control is missing or ambiguous");
    const target = visible[0];
    const details = await target.evaluate((el) => {
      const button = el as HTMLButtonElement;
      const form = button.closest("form");
      return {
        name: el.getAttribute("aria-label") ?? el.textContent ?? "",
        formAction: form?.getAttribute("action") ?? "",
        nativeSubmit:
          (el.tagName === "BUTTON" && button.type === "submit") ||
          (el.tagName === "INPUT" &&
            (el as HTMLInputElement).type === "submit"),
        hasApplicationFields: !!form?.querySelector(
          "input[type=file], [name*=resume], [name*=cover_letter]",
        ),
      };
    });
    authorizeAction(this.stage, purpose, details.name.trim(), details);
    const before = this.url();
    this.own();
    await target.click();
    await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    this.own();
    if (this.url() !== before) safeUrl(this.url(), this.fixture);
  }
  async inspect(): Promise<Field[]> {
    this.fields = [];
    for (const frame of this.page.frames()) {
      const locators = await frame
        .locator(
          "input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select,[role=combobox]:not(input):not(select),[role=checkbox]:not(input),[role=radio]:not(input)",
        )
        .all();
      for (const locator of locators) {
        if (
          (await locator.getAttribute("type")) === "file" &&
          (await locator.evaluate(
            (el) =>
              !!el.parentElement?.closest("[hidden],[aria-hidden=true]") ||
              (!!el.closest("section") &&
                getComputedStyle(el.closest("section")!).display === "none"),
          ))
        )
          continue;
        if (
          !(await locator.isEnabled()) ||
          (!(await locator.isVisible()) &&
            (await locator.getAttribute("type")) !== "file")
        )
          continue;
        const f = await locator.evaluate((el) => {
          const input = el as HTMLInputElement;
          const formEl = el as HTMLSelectElement;
          const labels =
            "labels" in el
              ? Array.from((el as HTMLInputElement).labels ?? [])
                  .map((l) => l.textContent ?? "")
                  .join(" ")
              : "";
          const by = el
            .getAttribute("aria-labelledby")
            ?.split(" ")
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const fieldset = el.closest("fieldset,[role=radiogroup]"),
            legend =
              fieldset?.querySelector("legend")?.textContent ??
              fieldset?.getAttribute("aria-label") ??
              "";
          const type =
            el.tagName === "SELECT"
              ? "select"
              : el.tagName === "TEXTAREA"
                ? "textarea"
                : ["combobox", "radio", "checkbox"].includes(
                      el.getAttribute("role") ?? "",
                    )
                  ? el.getAttribute("role")!
                  : (el.getAttribute("type") ?? "text");
          const label = (
            type === "radio"
              ? legend +
                " " +
                (labels || by || el.getAttribute("aria-label") || "")
              : labels ||
                by ||
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                (type === "file"
                  ? el
                      .closest("[data-automation-id],div")
                      ?.textContent?.slice(0, 150)
                  : "") ||
                ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const choices =
            el.tagName === "SELECT"
              ? Array.from(formEl.options)
                  .filter((o) => o.value !== "")
                  .map((o) => o.textContent ?? "")
              : [];
          const section =
            el.closest("section")?.querySelector("h2,h3")?.textContent ||
            document.querySelector("h1,h2")?.textContent ||
            "";
          const group = el.closest(
            "[data-record],[data-automation-id=workExperienceItem],[data-automation-id=educationItem]",
          );
          const peers = group?.parentElement
            ? Array.from(group.parentElement.children).filter((e) =>
                e.matches(
                  "[data-record],[data-automation-id=workExperienceItem],[data-automation-id=educationItem]",
                ),
              )
            : [];
          return {
            label,
            type,
            choices,
            required:
              input.required ||
              el.getAttribute("aria-required") === "true" ||
              /\*/.test(label),
            value:
              type === "checkbox" || type === "radio"
                ? input.checked || el.getAttribute("aria-checked") === "true"
                  ? "checked"
                  : ""
                : (input.value ?? ""),
            error:
              el.getAttribute("aria-invalid") === "true" ? "Invalid field" : "",
            section,
            maxLength: input.maxLength > 0 ? input.maxLength : undefined,
            groupIndex: group ? Math.max(0, peers.indexOf(group)) : 0,
            groupLabel: legend,
            optionLabel: labels || by || el.getAttribute("aria-label") || "",
            groupName: input.name,
            id: el.id,
          };
        });
        if (f.type === "password") continue;
        const field = { ...f, token: this.fields.length };
        let bound = locator;
        if (f.id) {
          const byId = frame.locator("[id=" + JSON.stringify(f.id) + "]");
          if ((await byId.count()) === 1) bound = byId;
        } else if (f.type !== "radio" && f.label) {
          const byLabel = frame.getByLabel(f.label, { exact: true });
          if ((await byLabel.count()) === 1) bound = byLabel;
          else if (f.groupName) {
            const byName = frame.locator(
              "[name=" + JSON.stringify(f.groupName) + "]",
            );
            if ((await byName.count()) === 1) bound = byName;
          }
        }
        this.fields.push({ field, locator: bound, frame });
      }
    }
    return this.fields.map((f) => f.field);
  }
  async fill(token: number, value: string) {
    await this.checkpoint();
    const b = this.fields[token];
    if (!b) throw new SafetyStop("Stale field reference");
    if (/password|file/.test(b.field.type))
      throw new SafetyStop("Use authorized credential/file interface");
    if (b.field.type === "select")
      await b.locator.selectOption({ label: value });
    else if (b.field.type === "checkbox" || b.field.type === "radio") {
      if (value === "Yes" || value === "checked") await b.locator.check();
      else if (b.field.type === "checkbox") await b.locator.uncheck();
    } else if (b.field.type === "combobox") {
      const button = await b.locator.evaluate((el) => el.tagName !== "INPUT");
      if (button) {
        if (
          await b.locator.evaluate(
            (el) =>
              el.tagName === "BUTTON" &&
              (el as HTMLButtonElement).type === "submit",
          )
        )
          throw new SafetyStop("Combobox could submit form");
        await b.locator.click();
      } else await b.locator.fill(value);
      const option = b.frame.getByRole("option", { name: value, exact: true });
      if ((await option.count()) !== 1)
        throw new SafetyStop("Autocomplete option is ambiguous");
      this.own();
      await option.click();
    } else await b.locator.fill(value);
    this.own();
  }
  async upload(token: number, path: string) {
    await this.checkpoint();
    const b = this.fields[token];
    if (b?.field.type !== "file")
      throw new SafetyStop("Expected authorized upload field");
    await b.locator.setInputFiles(path);
    const busy = this.page.getByText(
      /^(?:uploading|parsing resume|processing resume)[.\s]*$/i,
    );
    for (const indicator of await busy.all())
      if (await indicator.isVisible())
        await indicator.waitFor({ state: "hidden", timeout: 15000 });
    return await b.locator.evaluate(
      (el) => (el as HTMLInputElement).files?.[0]?.name ?? "",
    );
  }
  async credentials(email: string, password: string, create = false) {
    await this.checkpoint();
    if (this.stage !== (create ? "ACCOUNT_CREATE" : "AUTH"))
      throw new SafetyStop("Credential operation outside auth stage");
    if (
      /accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|github\.com\/login/i.test(
        this.url(),
      )
    )
      throw new SafetyStop(
        "Dedicated ATS credentials cannot be used for external identity-provider accounts",
      );
    const frames = [];
    for (const f of this.page.frames())
      if (await f.locator("input[type=password]:visible").count())
        frames.push(f);
    if (frames.length !== 1)
      throw new SafetyStop("Authentication frame is ambiguous");
    const frame = frames[0];
    if (
      /accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|github\.com\/login/i.test(
        frame.url(),
      )
    )
      throw new SafetyStop(
        "Dedicated ATS credentials cannot enter an identity-provider frame",
      );
    const inputs = frame.locator("input[type=email]");
    if ((await inputs.count()) !== 1)
      throw new SafetyStop("Account email field is ambiguous");
    this.own();
    await inputs.fill(email);
    const passwords = frame.locator("input[type=password]");
    const count = await passwords.count();
    if (count < 1 || count > 2)
      throw new SafetyStop("Unsupported credential form");
    for (const p of await passwords.all()) {
      this.own();
      await p.fill(password);
    }
  }
  async navigateVerification(url: string, origins: string[]) {
    const handler = async (route: import("playwright").Route) => {
      if (route.request().isNavigationRequest()) {
        try {
          const u = new URL(safeUrl(route.request().url()));
          if (!origins.includes(u.origin)) {
            await route.abort("blockedbyclient");
            return;
          }
        } catch {
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.fallback();
    };
    await this.page.route("**/*", handler);
    try {
      await this.navigate(url);
    } finally {
      await this.page.unroute("**/*", handler);
    }
  }
  async verificationCode(code: string) {
    this.own();
    if (this.stage !== "EMAIL_VERIFY")
      throw new SafetyStop("Code outside verification workflow");
    const input = this.page.getByLabel(
      /^(?:verification code|confirmation code)$/i,
    );
    if ((await input.count()) !== 1)
      throw new SafetyStop("Verification code field is ambiguous");
    this.own();
    await input.fill(code);
    await this.advance(
      "VERIFY_ACCOUNT",
      /^(?:verify|verify email|confirm email)$/i,
    );
  }
  async accountTerms() {
    this.own();
    if (this.stage !== "ACCOUNT_CREATE") return;
    for (const c of await this.page.getByRole("checkbox").all()) {
      const label = await c.evaluate(
        (el) =>
          el.getAttribute("aria-label") ??
          Array.from((el as HTMLInputElement).labels ?? [])
            .map((x) => x.textContent)
            .join(" "),
      );
      if (
        /terms|privacy/.test(label.toLowerCase()) &&
        !/marketing|newsletter|sms|talent|promotional/.test(
          label.toLowerCase(),
        ) &&
        (await c.evaluate(
          (el) =>
            (el as HTMLInputElement).required ||
            el.getAttribute("aria-required") === "true",
        ))
      ) {
        this.own();
        await c.check();
      }
    }
  }
  async authState() {
    let passwords = 0,
      email = 0;
    for (const frame of this.page.frames()) {
      passwords += await frame.locator("input[type=password]:visible").count();
      email += await frame.locator("input[type=email]:visible").count();
    }
    return { passwords, email };
  }
  async screenshot(path: string) {
    if (this.page.isClosed()) return;
    if (
      (await this.authState()).passwords ||
      /social security|ssn|government id|passport number/i.test(
        await this.text(),
      )
    )
      return;
    await this.page.screenshot({ path, fullPage: true });
  }
  async focus() {
    await this.page.bringToFront();
  }
  async close() {
    await this.page.close();
  }
  isClosed() {
    return this.page.isClosed();
  }
  takeOver() {
    this.ownership = "HUMAN";
  }
  resume() {
    this.ownership = "AUTOMATION";
  }
  async reviewEvidence() {
    const fields = await this.inspect();
    const missing = fields.filter(
      (f) =>
        f.required &&
        !f.value &&
        f.type !== "file" &&
        !(
          f.type === "radio" &&
          fields.some(
            (other) =>
              other.type === "radio" &&
              (f.groupName
                ? other.groupName === f.groupName
                : other.groupLabel === f.groupLabel) &&
              other.value === "checked",
          )
        ),
    );
    const errors = this.page.locator(
      "[role=alert]:visible,[aria-invalid=true]:visible",
    );
    let finalVisible = false;
    for (const frame of this.page.frames()) {
      const final = frame.getByRole("button", {
        name: /^(?:submit|submit application|send application|complete application|finish and submit|apply)$/i,
      });
      for (const c of await final.all())
        if (await c.isVisible()) finalVisible = true;
    }
    return { missing, errors: await errors.allTextContents(), finalVisible };
  }
}
