import { it, expect } from "vitest";
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
