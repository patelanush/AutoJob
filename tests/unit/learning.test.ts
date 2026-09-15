import { it, expect } from "vitest";
import { Store } from "../../src/db/store.js";
import { FactStore } from "../../src/answers/facts.js";
import { profileSchema } from "../../src/config/profile.js";
import { readFileSync } from "node:fs";
it("a changed private profile refreshes a fact originally imported from that profile", () => {
  const s = new Store(":memory:"),
    f = new FactStore(s),
    p = profileSchema.parse(
      JSON.parse(readFileSync("profile.example.json", "utf8")),
    );
  f.importProfile(p);
  p.personal.city = "A Different City";
  f.importProfile(p);
  expect(f.get("contact.city")?.parsed).toBe("A Different City");
  const raw = s.sqlite
    .prepare("SELECT * FROM facts WHERE canonical_key = 'contact.city'")
    .get() as { notes: string | null; source: string };
  expect(raw.notes).toBeNull();
  expect(raw.source).toBe("INITIAL_PROFILE");
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
it("keeps older profiles valid when newer optional demographics are absent", () => {
  const raw = JSON.parse(readFileSync("profile.example.json", "utf8")) as {
    demographics: Record<string, unknown>;
  };
  delete raw.demographics.transgender;
  delete raw.demographics.sexualOrientation;
  expect(profileSchema.parse(raw).demographics).toMatchObject({});
});
it("imports hierarchical race and independent demographic facts", () => {
  const s = new Store(":memory:"),
    f = new FactStore(s),
    p = profileSchema.parse(
      JSON.parse(readFileSync("profile.example.json", "utf8")),
    );
  p.demographics.race = ["Asian", "South Asian"];
  p.demographics.transgender = false;
  p.demographics.sexualOrientation = "Heterosexual";
  f.importProfile(p);
  expect(f.get("demographics.race")?.parsed).toEqual(["Asian", "South Asian"]);
  expect(f.get("demographics.race.asian")?.parsed).toBe(true);
  expect(f.get("demographics.race.southAsian")?.parsed).toBe(true);
  expect(f.get("demographics.race.eastAsian")).toBeNull();
  expect(f.get("demographics.race.southeastAsian")).toBeNull();
  expect(f.get("demographics.transgender")?.parsed).toBe(false);
  expect(f.get("demographics.sexualOrientation")?.parsed).toBe("Heterosexual");
  s.close();
});
