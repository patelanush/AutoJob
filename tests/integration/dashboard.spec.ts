import { test, expect } from "@playwright/test";
import { createAPI } from "../../src/cli/server.js";
import { Store } from "../../src/db/store.js";
import { Runtime } from "../../src/runs/runtime.js";
import { FactStore } from "../../src/answers/facts.js";
import { identify } from "../../src/feed/identity.js";
import { mkdirSync } from "node:fs";
test("dashboard renders operational queue and knowledge base", async ({
  page,
}) => {
  const store = new Store(":memory:");
  for (const [i, company] of [
    "Acme Labs",
    "Northstar Systems",
    "Fieldstone",
    "Atlas Research",
  ].entries()) {
    const identity = identify(`https://example.com/jobs/${i}`);
    store.ingest(
      [
        {
          company,
          role: i === 1 ? "Graduate Hardware Engineer" : "Software Engineer I",
          category: "Fixture",
          locationRaw: i === 1 ? "Austin, TX" : "Phoenix, AZ",
          originalApplyUrl: identity.canonicalUrl,
          simplifyUrl: null,
          ageDays: i,
          isClosed: false,
          observationKey: company,
          identity,
        },
      ],
      7,
    );
    const a = store
      .queue()
      .find((a) => store.job(a.jobId).company === company)!;
    store.startAttempt(a.id);
    store.transition(
      a.id,
      i === 0
        ? "READY"
        : i === 1
          ? "NEEDS_REVIEW"
          : i === 2
            ? "SKIPPED"
            : "SUBMITTED",
      {
        attentionReason:
          i === 1
            ? "Answer required question: Desired salary"
            : i === 2
              ? "Application is closed"
              : null,
      },
    );
  }
  const facts = new FactStore(store);
  facts.set("experience.pythonYears", 3);
  const runtime = {
      store,
      facts,
      sessions: { retained: () => 2 },
      busy: false,
      paused: false,
    } as unknown as Runtime,
    port = 14317;
  const app = await createAPI(runtime, port);
  await app.listen({ host: "127.0.0.1", port });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Your application queue" }),
    ).toBeVisible();
    await expect(page.getByText("Acme Labs", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Answer required question: Desired salary", {
        exact: true,
      }),
    ).toBeVisible();
    mkdirSync("data", { recursive: true });
    await page.screenshot({
      path: "data/dashboard-preview.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "My Application Facts" }).click();
    await expect(
      page.getByText("experience.pythonYears", { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    store.close();
  }
});
