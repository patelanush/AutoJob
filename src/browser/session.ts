import { chromium, type BrowserContext, type Page } from "playwright";
import { BrowserActions } from "./actions.js";
import { paths, type Profile } from "../config/profile.js";
import { Store } from "../db/store.js";
import { HostSafety } from "./hosts.js";
import { adapters } from "../ats/index.js";
export class Sessions {
  private context?: BrowserContext;
  private pages = new Map<string, { page: Page; actions: BrowserActions }>();
  readonly hosts = new HostSafety();
  constructor(
    readonly store: Store,
    readonly profile: Profile,
  ) {}
  async start() {
    if (this.context) return;
    this.context = await chromium.launchPersistentContext(paths.browser, {
      headless: false,
      acceptDownloads: false,
    });
    this.context.on("close", () => {
      this.context = undefined;
      for (const id of this.pages.keys()) this.lost(id);
      this.pages.clear();
    });
    for (const page of this.context.pages()) {
      if (page.url() === "about:blank") continue;
      const matches = this.store
        .list()
        .filter(
          (a) =>
            ["READY", "NEEDS_REVIEW"].includes(a.application.status) &&
            (a.application.lastUrl === page.url() ||
              a.job.canonicalApplyUrl === page.url()),
        );
      if (matches.length === 1 && !this.has(matches[0].application.id)) {
        const b = await this.bind(matches[0].application.id, page);
        b.takeOver();
        this.store.event(
          matches[0].application.id,
          "SESSION_RESTORED",
          "Matched a restored browser tab. Resume to verify the saved form.",
        );
      }
    }
  }
  private async bind(id: string, page: Page) {
    const actions = new BrowserActions(page);
    await actions.installGuard();
    this.pages.set(id, { page, actions });
    this.store.update(id, { sessionAvailable: true });
    page.on("close", () => {
      this.pages.delete(id);
      this.lost(id);
    });
    page.on("response", (r) => {
      if (r.request().isNavigationRequest())
        this.hosts.response(new URL(r.url()).hostname, r.status());
    });
    return actions;
  }
  private lost(id: string) {
    const a = this.store.application(id);
    if (a.status === "READY" || a.status === "PROCESSING")
      this.store.transition(id, "NEEDS_REVIEW", {
        sessionAvailable: false,
        attentionReason:
          "Application tab/form was lost. Open and Resume to verify recovery.",
        retryable: true,
      });
    else this.store.update(id, { sessionAvailable: false });
  }
  retained() {
    return (
      this.context
        ?.pages()
        .filter(
          (p) =>
            !p.isClosed() &&
            (p.url() !== "about:blank" ||
              [...this.pages.values()].some((bound) => bound.page === p)),
        ).length ?? 0
    );
  }
  has(id: string) {
    return this.pages.has(id) && !this.pages.get(id)!.page.isClosed();
  }
  async get(id: string) {
    if (this.has(id)) return this.pages.get(id)!.actions;
    await this.start();
    if (this.has(id)) return this.pages.get(id)!.actions;
    if (this.retained() >= this.profile.browser.reviewTabLimit)
      throw new Error(
        "Review tab limit reached. Submit or explicitly close a review tab.",
      );
    return this.bind(id, await this.context!.newPage());
  }
  async focus(id: string) {
    const a = this.store.application(id);
    this.pages.get(id)?.actions.takeOver();
    if (a.status === "PROCESSING") {
      this.store.transition(id, "NEEDS_REVIEW", {
        attentionReason:
          "Human takeover. Automation paused until explicit Resume.",
      });
      this.store.event(
        id,
        "TAKEOVER",
        "Human requested application focus; worker ownership released.",
      );
    }
    const live = this.has(id),
      b = await this.get(id);
    if (!live && b.url() === "about:blank") {
      b.resume();
      await b.navigate(a.lastUrl ?? this.store.job(a.jobId).canonicalApplyUrl);
      b.takeOver();
    } else b.takeOver();
    await b.focus();
  }
  takeOver(id: string) {
    this.pages.get(id)?.actions.takeOver();
  }
  async close(id: string) {
    const p = this.pages.get(id);
    if (p && !p.page.isClosed()) await p.actions.close();
  }
  async observe(onSubmitted: (id: string) => Promise<void>) {
    for (const [id, p] of this.pages) {
      const a = this.store.application(id);
      if (
        !["READY", "NEEDS_REVIEW"].includes(a.status) ||
        p.actions.ownership !== "HUMAN"
      )
        continue;
      const text = await p.actions.text().catch(() => ""),
        u = p.actions.url(),
        job = this.store.job(a.jobId);
      const adapter = adapters.find((a) => a.type === job.atsType)!;
      if (!adapter.detectSuccess(text, u)) continue;
      if (
        !a.preparedAt &&
        a.stage !== "REVIEW" &&
        !/your application (?:has been|was) submitted|application received/i.test(
          text,
        )
      )
        continue;
      const evidence = await p.actions.reviewEvidence();
      if (evidence.finalVisible || evidence.errors.some((e) => e.trim()))
        continue;
      if (
        new URL(u).origin === new URL(job.canonicalApplyUrl).origin ||
        new URL(a.lastUrl ?? u).origin === new URL(u).origin
      )
        await onSubmitted(id);
    }
  }
  async shutdown() {
    await this.context?.close();
  }
}
