import { it, expect, vi } from "vitest";
import { createAPI } from "../../src/cli/server.js";
import { Runtime } from "../../src/runs/runtime.js";
import { Store } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
it("API rejects remote Host and cross-origin mutations", async () => {
  const store = new Store(":memory:"),
    runtime = {
      store,
      facts: new FactStore(store),
      sessions: { retained: () => 0 },
      busy: false,
      paused: false,
    } as unknown as Runtime;
  const app = await createAPI(runtime);
  const badHost = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { host: "evil.example" },
  });
  expect(badHost.statusCode).toBe(403);
  const session = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { host: "127.0.0.1:4317" },
  });
  expect(session.statusCode).toBe(200);
  const bad = await app.inject({
    method: "POST",
    url: "/api/facts",
    headers: {
      host: "127.0.0.1:4317",
      origin: "https://evil.example",
      "x-csrf-token": session.json().csrf,
    },
    payload: { key: "experience.pythonYears", value: 3 },
  });
  expect(bad.statusCode).toBe(403);
  const valid = await app.inject({
    method: "POST",
    url: "/api/facts",
    headers: {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "x-csrf-token": session.json().csrf,
    },
    payload: { key: "experience.pythonYears", value: 3 },
  });
  expect(valid.statusCode).toBe(200);
  expect(runtime.facts.get("experience.pythonYears")?.parsed).toBe(3);
  await app.close();
  store.close();
});

it("API validates and forwards live-run queue filters", async () => {
  const store = new Store(":memory:"),
    ingest = vi.fn(async () => ({ queued: 1 })),
    retry = vi.fn(async () => undefined),
    runtime = {
      store,
      facts: new FactStore(store),
      sessions: { retained: () => 0 },
      busy: false,
      paused: false,
      ingest,
      retry,
    } as unknown as Runtime,
    app = await createAPI(runtime),
    session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { host: "127.0.0.1:4317" },
    }),
    headers = {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "x-csrf-token": session.json().csrf,
    };
  for (const limit of [0, -1, 1.5, "abc"])
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/run",
          headers,
          payload: { lookback: 7, limit },
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/run",
        headers,
        payload: { lookback: 7, limit: 1 },
      })
    ).statusCode,
  ).toBe(200);
  expect(ingest).toHaveBeenCalledWith(7, 1, undefined);
  ingest.mockClear();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/run",
        headers,
        payload: { lookback: 7 },
      })
    ).statusCode,
  ).toBe(200);
  expect(ingest).toHaveBeenCalledWith(7, undefined, undefined);
  ingest.mockClear();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/run",
        headers,
        payload: { lookback: 7, ats: "workday", limit: 1 },
      })
    ).statusCode,
  ).toBe(200);
  expect(ingest).toHaveBeenCalledWith(7, 1, "workday");
  for (const ats of ["lever", "Workday", "", 7])
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/run",
          headers,
          payload: { lookback: 7, ats },
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/applications/11111111-1111-4111-8111-111111111111/resume",
        headers,
        payload: { only: true },
      })
    ).statusCode,
  ).toBe(200);
  expect(retry).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111",
    false,
    true,
  );
  await app.close();
  store.close();
});
