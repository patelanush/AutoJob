import { it, expect } from "vitest";
import { Store } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
import { profileSchema } from "../../src/config/profile.js";
import { readFileSync } from "node:fs";
it("a changed private profile creates a visible conflict; an explicit correction resolves it", () => {
  const s = new Store(":memory:"),
    f = new FactStore(s),
    p = profileSchema.parse(
      JSON.parse(readFileSync("profile.example.json", "utf8")),
    );
  f.importProfile(p);
  p.personal.city = "A Different City";
  f.importProfile(p);
  expect(f.get("contact.city")).toBeNull();
  const raw = s.sqlite
    .prepare("SELECT * FROM facts WHERE canonical_key = 'contact.city'")
    .get() as { notes: string };
  expect(raw.notes).toContain("PROFILE_CONFLICT");
  f.set("contact.city", "A Different City", {
    correct: true,
    source: "HUMAN_CORRECTED",
  });
  f.importProfile(p);
  expect(f.get("contact.city")?.parsed).toBe("A Different City");
  s.close();
});
it("stale profile does not override a human correction", () => {
  const s = new Store(":memory:"),
    f = new FactStore(s),
    p = profileSchema.parse(
      JSON.parse(readFileSync("profile.example.json", "utf8")),
    );
  f.importProfile(p);
  f.set("contact.city", "Confirmed City", {
    correct: true,
    source: "HUMAN_CORRECTED",
  });
  f.importProfile(p);
  expect(f.get("contact.city")?.parsed).toBe("Confirmed City");
  s.close();
});
it("temporary expired facts are not reused", () => {
  const s = new Store(":memory:"),
    f = new FactStore(s);
  f.set("availability.startDate", "2024-01-01", {
    stability: "TEMPORARY",
    expiresAt: "2024-01-01T00:00:00.000Z",
  });
  expect(f.get("availability.startDate")).toBeNull();
  s.close();
});
it("canonical fact types reject unsafe citizenship and experience values", () => {
  const s = new Store(":memory:"),
    f = new FactStore(s);
  expect(() => f.set("identity.citizenship", true)).toThrow("country");
  expect(() => f.set("experience.pythonYears", "many")).toThrow("number");
  expect(() => f.set("auth.password", "never")).toThrow();
  s.close();
});
