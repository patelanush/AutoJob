import {
  BrowserActions,
  SafetyStop,
  type Stage,
} from "../../browser/actions.js";
import { prepareFields } from "../../forms/prepare.js";
import {
  AnswerResolver,
  type GenerationContext,
} from "../../answers/resolver.js";
import { type Profile } from "../../config/profile.js";
import { Store, now } from "../../db/store.js";
import { siteAccounts } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ValidationEngine } from "../../forms/validation.js";
export interface AdapterContext {
  browser: BrowserActions;
  resolver: AnswerResolver;
  profile: Profile;
  store: Store;
  appId: string;
  generation: GenerationContext;
  password: () => Promise<string>;
  authPermit?: () => boolean;
  verify?: (browser: BrowserActions) => Promise<boolean>;
}
export interface AdapterResult {
  status: "READY" | "NEEDS_REVIEW" | "SKIPPED";
  reason: string | null;
  missing: string[];
  stage: Stage;
  retryable: boolean;
}
export interface ATSAdapter {
  type: string;
  canHandle(signature: { url: string; html: string; text: string }): boolean;
  prepare(context: AdapterContext): Promise<AdapterResult>;
  detectSuccess(text: string, url: string): boolean;
}
export interface Rules {
  type: string;
  signature: RegExp;
  stages: Stage[];
  next: RegExp;
  begin: RegExp;
  finalRequests: RegExp[];
}
function outcome(
  status: AdapterResult["status"],
  stage: Stage,
  reason: string | null,
  missing: string[] = [],
  retryable = false,
): AdapterResult {
  return { status, stage, reason, missing, retryable };
}
export class StructuredAdapter implements ATSAdapter {
  readonly type: string;
  constructor(readonly rules: Rules) {
    this.type = rules.type;
  }
  canHandle(s: { url: string; html: string; text: string }) {
    return this.rules.signature.test(s.url + " " + s.html);
  }
  detectSuccess(text: string, url: string) {
    return (
      /your application (?:has been|was) submitted|application received|thank you for applying/i.test(
        text,
      ) &&
      !/error|not submitted|unable to submit/i.test(text.slice(0, 1200)) &&
      /^https?:/.test(url)
    );
  }
  private async authenticate(c: AdapterContext): Promise<AdapterResult | null> {
    const { browser: b, profile: p, store, appId } = c,
      job = store.job(store.application(appId).jobId),
      account = store.db
        .select()
        .from(siteAccounts)
        .where(eq(siteAccounts.tenant, job.tenant))
        .get();
    if (account && account.email !== p.personal.email)
      return outcome(
        "NEEDS_REVIEW",
        "AUTH",
        "Saved tenant account uses another email. Confirm the correct account.",
      );
    const state = await b.authState();
    if (!state.passwords) return null;
    b.stage = "AUTH";
    store.update(appId, { stage: "AUTH" });
    if (c.authPermit && !c.authPermit())
      return outcome(
        "NEEDS_REVIEW",
        "AUTH",
        "A credential attempt was already made for this tenant during this run. Resolve authentication manually.",
      );
    store.event(appId, "AUTH", "Using one dedicated ATS credential attempt.");
    let password: string;
    try {
      password = await c.password();
    } catch {
      return outcome(
        "NEEDS_REVIEW",
        "AUTH",
        "Set the dedicated ATS password using npm run credentials -- ats.",
      );
    }
    await b.credentials(p.personal.email, password);
    await b.advance("LOGIN", /^(?:sign in|log in|login)$/i);
    let text = await b.text();
    if ((await b.authState()).passwords) {
      if (
        !/account (?:does not|doesnt) exist|no account found|email (?:is )?not registered/i.test(
          text,
        )
      )
        return outcome(
          "NEEDS_REVIEW",
          "AUTH",
          "Login failed or account existence is ambiguous. Resolve login manually; no automatic registration/reset.",
        );
      if (!(await b.hasControl(/^create account$/i)))
        return outcome(
          "NEEDS_REVIEW",
          "AUTH",
          "No account exists; normal registration is not available.",
        );
      b.stage = "ACCOUNT_CREATE";
      await b.advance("ACCOUNT_CREATE", /^create account$/i);
      await b.credentials(p.personal.email, password, true);
      await b.accountTerms();
      await b.advance(
        "ACCOUNT_CREATE",
        /^(?:create account|register|sign up)$/i,
      );
      text = await b.text();
      if ((await b.authState()).passwords)
        return outcome(
          "NEEDS_REVIEW",
          "ACCOUNT_CREATE",
          "Account creation did not complete; check password policy or validation.",
        );
    }
    if (
      /verify your email|verification email|confirm your email|verification code/i.test(
        text,
      )
    ) {
      b.stage = "EMAIL_VERIFY";
      store.update(appId, { stage: "EMAIL_VERIFY" });
      if (!c.verify || !(await c.verify(b)))
        return outcome(
          "NEEDS_REVIEW",
          "EMAIL_VERIFY",
          "Complete account email verification, then Resume.",
        );
    }
    store.db
      .insert(siteAccounts)
      .values({
        id: randomUUID(),
        tenant: job.tenant,
        email: p.personal.email,
        credentialRef: "ats-default-password",
        createdAt: now(),
        lastSuccessfulLoginAt: now(),
      })
      .onConflictDoUpdate({
        target: siteAccounts.tenant,
        set: { lastSuccessfulLoginAt: now() },
      })
      .run();
    return null;
  }
  async prepare(c: AdapterContext): Promise<AdapterResult> {
    const b = c.browser;
    await b.installGuard(this.rules.finalRequests);
    let totalFilled = 0,
      resumeUploaded = false;
    let previousSection: string | null = null;
    for (let step = 0; step < 25; step++) {
      await b.beforeMutation?.();
      await this.beforeStep(c);
      const text = await b.text();
      if (/account (?:is |has been )?locked|too many failed login/i.test(text))
        return outcome(
          "SKIPPED",
          "AUTH",
          "Account locked; resolve the security restriction manually before any new attempt.",
        );
      if (
        /accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|github\.com\/login/i.test(
          b.url(),
        )
      )
        return outcome(
          "NEEDS_REVIEW",
          "AUTH",
          "External identity-provider authentication requires human control. The dedicated ATS password will not be sent there.",
        );
      if (
        /application (?:is |has been )?closed|job (?:is )?no longer available|position (?:has been )?filled/i.test(
          text,
        )
      )
        return outcome("SKIPPED", b.stage, "Position is closed.");
      if (
        /captcha|verify you are human|checking your browser|access denied|unusual traffic|cloudflare.*challenge/i.test(
          text,
        )
      )
        return outcome(
          totalFilled ? "NEEDS_REVIEW" : "SKIPPED",
          b.stage,
          "Security challenge requires a human; no bypass or retries.",
        );
      if (
        /authenticator|multi.factor|two.factor|text message.*code|sms verification/i.test(
          text,
        )
      )
        return outcome(
          "NEEDS_REVIEW",
          b.stage,
          "Complete SMS/MFA verification, then Resume.",
        );
      if (
        /coding assessment|personality assessment|recorded interview|start assessment/i.test(
          text,
        )
      )
        return outcome(
          totalFilled ? "NEEDS_REVIEW" : "SKIPPED",
          b.stage,
          "External assessment is outside automation scope.",
        );
      const signed = text.match(/signed in as\s+([^\s]+@[^\s]+)/i);
      if (
        signed &&
        signed[1].toLowerCase() !== c.profile.personal.email.toLowerCase()
      )
        return outcome(
          "NEEDS_REVIEW",
          "AUTH",
          "Browser is signed in with a different account.",
        );
      if (
        /verify your email|verification email|confirm your email|verification code/i.test(
          text,
        )
      ) {
        b.stage = "EMAIL_VERIFY";
        c.store.update(c.appId, { stage: "EMAIL_VERIFY" });
        if (!c.verify || !(await c.verify(b)))
          return outcome(
            "NEEDS_REVIEW",
            "EMAIL_VERIFY",
            "Complete account email verification, then Resume.",
          );
        continue;
      }
      const auth = await this.authenticate(c);
      if (auth) return auth;
      const fields = await b.inspect();
      const sectionIdentity =
        b.url() +
        "|" +
        fields
          .map((f) => f.section + "|" + f.label + "|" + f.groupIndex)
          .join(";");
      if (sectionIdentity === previousSection)
        return outcome(
          "NEEDS_REVIEW",
          b.stage,
          "The previous navigation did not advance to a new section. Resolve validation/loading, then Resume.",
        );
      previousSection = sectionIdentity;
      if (
        b.stage === "LANDING" &&
        !fields.some((f) => /email|first.?name|resume/i.test(f.label)) &&
        (await b.hasControl(this.rules.begin))
      ) {
        await b.advance("BEGIN", this.rules.begin);
        continue;
      }
      if (
        !fields.length &&
        !(await b.hasControl(
          /^(?:submit|submit application|send application|complete application|finish and submit)$/i,
        ))
      )
        return outcome(
          totalFilled ? "NEEDS_REVIEW" : "SKIPPED",
          b.stage,
          "No supported application fields or verified final review state found.",
        );
      const section = fields.map((f) => f.section).join(" ");
      const stage: Stage = /education/i.test(section)
        ? "EDUCATION"
        : /experience|employment/i.test(section)
          ? "EXPERIENCE"
          : /disclosure|self identification|equal employment/i.test(section)
            ? "DISCLOSURES"
            : fields.some((f) => f.type === "file")
              ? "RESUME"
              : fields.some((f) => /first name|email/i.test(f.label))
                ? "CONTACT"
                : "QUESTIONS";
      b.stage = stage;
      c.store.update(c.appId, { stage, lastUrl: b.url() });
      await this.ensureRecords(c, stage);
      const prepared = await prepareFields(
        b,
        c.resolver,
        c.profile,
        c.appId,
        c.generation,
      );
      totalFilled += prepared.filled;
      resumeUploaded ||= prepared.resumeUploaded;
      if (await b.securityChallenge())
        return outcome(
          totalFilled ? "NEEDS_REVIEW" : "SKIPPED",
          stage,
          "Security challenge requires a human; no bypass or retries.",
        );
      c.store.event(
        c.appId,
        "FILLED",
        `Prepared ${prepared.filled} supported fields.`,
        { missingCount: prepared.missing.length },
      );
      if (prepared.missing.length)
        return outcome(
          "NEEDS_REVIEW",
          stage,
          prepared.missing[0],
          prepared.missing,
        );
      const evidence = await new ValidationEngine().validate(
        b,
        c.resolver.factStore,
      );
      if (evidence.incorrect.length)
        return outcome(
          "NEEDS_REVIEW",
          stage,
          evidence.incorrect[0],
          evidence.incorrect,
        );
      if (evidence.errors.some((e) => e.trim()))
        return outcome(
          "NEEDS_REVIEW",
          stage,
          "Visible application validation errors remain.",
          evidence.errors,
        );
      if (evidence.finalVisible) {
        const pending = c.store
          .details(c.appId)
          .questions.filter((q) => !q.resolved);
        if (pending.length)
          return outcome(
            "NEEDS_REVIEW",
            "REVIEW",
            "Confirm previously unanswered factual questions in the dashboard.",
            pending.map((q) => q.question),
          );
        const missing = evidence.missing
          .filter((f) => !humanOnlyFinal(f.label))
          .map((f) => f.label);
        if (missing.length)
          return outcome(
            "NEEDS_REVIEW",
            "REVIEW",
            "Required fields remain incomplete.",
            missing,
          );
        if (
          fields.some(
            (f) =>
              f.type === "file" && f.required && /resume|cv/i.test(f.label),
          ) &&
          !resumeUploaded
        )
          return outcome(
            "NEEDS_REVIEW",
            "REVIEW",
            "Required resume upload is not verified.",
          );
        b.stage = "REVIEW";
        c.store.event(
          c.appId,
          "SUBMIT_BLOCKED",
          "Final review reached; submission remains human-only.",
        );
        return outcome(
          "READY",
          "REVIEW",
          evidence.missing.length
            ? "Review and complete the final human attestation."
            : null,
        );
      }
      if (await b.hasControl(/^review(?: application)?$/i)) {
        await b.advance("REVIEW", /^review(?: application)?$/i);
        continue;
      }
      if (this.type === "generic")
        return outcome(
          "NEEDS_REVIEW",
          stage,
          "Generic multipage navigation requires human review.",
        );
      if (await b.hasControl(this.rules.next)) {
        try {
          await b.advance("NEXT", this.rules.next);
        } catch (e) {
          if (e instanceof SafetyStop && e.reason === "TAKEOVER") throw e;
          return outcome(
            "NEEDS_REVIEW",
            stage,
            "Next action is ambiguous or could submit the application.",
          );
        }
        continue;
      }
      return outcome(
        "NEEDS_REVIEW",
        stage,
        "No verified next section or final submission control.",
      );
    }
    return outcome(
      "NEEDS_REVIEW",
      b.stage,
      "Workflow step limit reached; resume manually.",
    );
  }
  protected async beforeStep(c: AdapterContext) {
    void c;
  }
  protected async ensureRecords(c: AdapterContext, stage: Stage) {
    if (!["EXPERIENCE", "EDUCATION"].includes(stage)) return;
    const records = c.resolver.factStore.get(
      stage === "EDUCATION" ? "education.records" : "employment.records",
    )?.parsed as unknown[] | undefined;
    if (!records?.length) return;
    for (let attempt = 0; attempt < records.length; attempt++) {
      const fields = await c.browser.inspect();
      const count = fields.length
        ? Math.max(...fields.map((f) => f.groupIndex)) + 1
        : 0;
      if (count >= records.length) return;
      const name =
        stage === "EDUCATION"
          ? /^add(?: another)?(?: education| school)$/i
          : /^add(?: another)?(?: work| employment| experience)$/i;
      if (!(await c.browser.hasControl(name))) return;
      await c.browser.advance("ADD_RECORD", name);
    }
  }
}
function humanOnlyFinal(label: string) {
  return /i certify|electronic signature|i attest/i.test(label);
}
